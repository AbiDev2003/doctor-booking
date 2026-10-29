import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  apiArriveAppointment,
  apiCancelAppointment,
  apiCollectOfflinePayment,
  apiCompleteAppointment,
  apiMarkNoShow,
  apiPublicClinic,
  apiPublicDoctorAvailability,
  apiRejectAppointment,
  apiRescheduleAppointment,
  apiStaffDoctors,
  apiVoidOfflinePayment,
  ApiError,
} from "@/lib/api"
import type { DeskAppointment } from "@/lib/api"
import { addDays, clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ReasonDialog } from "@/components/staff/reason-dialog"

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

type ReasonAction = "reject" | "cancel" | "void"

function errorMessage(error: unknown): string | undefined {
  return error instanceof ApiError ? error.message : undefined
}

/**
 * The attendance and money buttons for one desk appointment.
 *
 * Which buttons are live is the server's answer (`canArrive`, `canComplete`, …),
 * never the client's reading of status + clock. A disabled button still renders
 * and carries the server's blocked reason, so the desk learns why check-in is
 * closed instead of wondering where the button went.
 */
export function AppointmentActions({
  appointment,
  onChanged,
}: {
  appointment: DeskAppointment
  onChanged?: () => void
}) {
  const queryClient = useQueryClient()
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null)
  const [collectOpen, setCollectOpen] = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["staff"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    onChanged?.()
  }

  const transition = useMutation({
    mutationFn: (kind: "arrive" | "complete" | "no-show") => {
      if (kind === "arrive") return apiArriveAppointment(appointment.id)
      if (kind === "complete") return apiCompleteAppointment(appointment.id)
      return apiMarkNoShow(appointment.id)
    },
    onSuccess: refresh,
  })

  const reason = useMutation({
    mutationFn: async ({ action, reason }: { action: ReasonAction; reason: string }) => {
      if (action === "reject") await apiRejectAppointment(appointment.id, reason)
      else if (action === "cancel") await apiCancelAppointment(appointment.id, reason)
      else await apiVoidOfflinePayment({ appointmentId: appointment.id, reason })
    },
    onSuccess: () => {
      setReasonAction(null)
      refresh()
    },
  })

  const busy = transition.isPending || reason.isPending
  const inlineError = errorMessage(transition.error) ?? errorMessage(reason.error)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {appointment.payment.outstandingPaise > 0 && (
          <Button size="sm" onClick={() => setCollectOpen(true)}>
            Collect {formatPaise(appointment.payment.outstandingPaise, "INR")}
          </Button>
        )}

        {appointment.payment.status === "PENDING" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReasonAction("void")}>
            Void due
          </Button>
        )}

        {appointment.status === "CONFIRMED" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !appointment.canArrive}
            title={appointment.arriveBlockedReason ?? undefined}
            onClick={() => transition.mutate("arrive")}
          >
            Check in
          </Button>
        )}

        {appointment.status === "ARRIVED" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !appointment.canComplete}
            title={appointment.completeBlockedReason ?? undefined}
            onClick={() => transition.mutate("complete")}
          >
            Complete
          </Button>
        )}

        {appointment.status === "CONFIRMED" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !appointment.canNoShow}
            title={appointment.noShowBlockedReason ?? undefined}
            onClick={() => transition.mutate("no-show")}
          >
            No-show
          </Button>
        )}

        {appointment.canReschedule && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setRescheduleOpen(true)}>
            Reschedule
          </Button>
        )}

        {appointment.canCancel && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReasonAction("cancel")}>
            Cancel
          </Button>
        )}

        {appointment.canReject && (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => setReasonAction("reject")}>
            Reject
          </Button>
        )}
      </div>

      {appointment.status === "CONFIRMED" && !appointment.canArrive && appointment.arriveBlockedReason !== null && (
        <p className="text-xs text-muted-foreground">{appointment.arriveBlockedReason}</p>
      )}
      {appointment.status === "ARRIVED" && !appointment.canComplete && appointment.completeBlockedReason !== null && (
        <p className="text-xs text-muted-foreground">{appointment.completeBlockedReason}</p>
      )}

      {inlineError !== undefined && (
        <Alert variant="destructive">
          <AlertTitle>Action refused</AlertTitle>
          <AlertDescription>{inlineError}</AlertDescription>
        </Alert>
      )}

      <ReasonDialog
        open={reasonAction !== null}
        onOpenChange={(open) => {
          if (!open) setReasonAction(null)
        }}
        title={
          reasonAction === "reject"
            ? "Reject this booking"
            : reasonAction === "cancel"
              ? "Cancel this booking"
              : "Void this unpaid due"
        }
        description={
          reasonAction === "reject"
            ? "Rejecting refuses the booking at the desk. The reason is mandatory and audited."
            : reasonAction === "cancel"
              ? "Cancelling frees the seat and may queue a refund. The reason is mandatory and audited."
              : "Voiding writes off the unpaid receivable. No money is recorded as collected, and the reason is audited."
        }
        confirmLabel={
          reasonAction === "reject"
            ? "Reject booking"
            : reasonAction === "cancel"
              ? "Cancel booking"
              : "Void due"
        }
        pending={reason.isPending}
        error={errorMessage(reason.error)}
        onConfirm={(value) => {
          if (reasonAction !== null) reason.mutate({ action: reasonAction, reason: value })
        }}
      />

      {collectOpen && (
        <CollectDialog
          appointment={appointment}
          onClose={() => setCollectOpen(false)}
          onCollected={() => {
            setCollectOpen(false)
            refresh()
          }}
        />
      )}

      {rescheduleOpen && (
        <RescheduleDialog
          appointment={appointment}
          onClose={() => setRescheduleOpen(false)}
          onMoved={() => {
            setRescheduleOpen(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function CollectDialog({
  appointment,
  onClose,
  onCollected,
}: {
  appointment: DeskAppointment
  onClose: () => void
  onCollected: () => void
}) {
  const [method, setMethod] = useState<"CASH" | "CARD" | "UPI">("CASH")
  const [amount, setAmount] = useState("")

  const collect = useMutation({
    mutationFn: () => {
      const rupees = amount.trim() === "" ? undefined : Number(amount)
      const amountPaise = rupees === undefined ? undefined : Math.round(rupees * 100)
      return apiCollectOfflinePayment({
        appointmentId: appointment.id,
        method,
        ...(amountPaise !== undefined && { amountPaise }),
      })
    },
    onSuccess: onCollected,
  })

  const invalidAmount = amount.trim() !== "" && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record pay-at-clinic payment</DialogTitle>
          <DialogDescription>
            {appointment.patient.fullName} owes {formatPaise(appointment.payment.outstandingPaise, "INR")}. Leave the
            amount blank to collect the full outstanding fee; a smaller amount is a recorded concession.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="pay-method">Method</Label>
          <select
            id="pay-method"
            className={SELECT_CLASS}
            value={method}
            onChange={(event) => setMethod(event.target.value as "CASH" | "CARD" | "UPI")}
          >
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="UPI">UPI</option>
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pay-amount">Amount in rupees (optional)</Label>
          <Input
            id="pay-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={(appointment.payment.outstandingPaise / 100).toFixed(2)}
          />
          {invalidAmount && <p className="text-xs text-destructive">Enter a positive amount.</p>}
        </div>

        {collect.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not record the payment</AlertTitle>
            <AlertDescription>{errorMessage(collect.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={collect.isPending}>
            Close
          </Button>
          <Button disabled={collect.isPending || invalidAmount} onClick={() => collect.mutate()}>
            {collect.isPending ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RescheduleDialog({
  appointment,
  onClose,
  onMoved,
}: {
  appointment: DeskAppointment
  onClose: () => void
  onMoved: () => void
}) {
  const [doctorId, setDoctorId] = useState(appointment.doctorId)
  const [date, setDate] = useState<string | null>(null)
  const [reason, setReason] = useState("")

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: () => apiStaffDoctors() })

  const timezone = clinic.data?.clinic.timezone
  const horizonDays = clinic.data?.clinic.bookingHorizonDays
  const minDate = timezone === undefined ? "" : clinicToday(timezone)
  const maxDate = minDate !== "" && horizonDays !== undefined ? addDays(minDate, horizonDays) : ""
  const selectedDate = date ?? (minDate !== "" ? minDate : null)

  const availability = useQuery({
    queryKey: ["public", "availability", doctorId, selectedDate],
    queryFn: () => apiPublicDoctorAvailability(doctorId, selectedDate as string),
    enabled: selectedDate !== null,
  })

  const move = useMutation({
    mutationFn: (slotId: string) => apiRescheduleAppointment(appointment.id, slotId, reason.trim()),
    onSuccess: onMoved,
  })

  const slots = (availability.data?.availability ?? []).filter((slot) => slot.slotId !== appointment.slotId)
  const bookableDoctors = (doctors.data?.doctors ?? []).filter(
    (doctor) => doctor.isBookable || doctor.id === appointment.doctorId,
  )
  const canSubmitReason = reason.trim() !== ""

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reschedule at the desk</DialogTitle>
          <DialogDescription>
            Move {appointment.patient.fullName}&apos;s booking from {formatSlotDate(appointment.slotDate)} ·{" "}
            {formatTimeRange(appointment.startTime, appointment.endTime)}. The desk may cross doctors; a reason is
            mandatory and audited.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="reschedule-doctor">Doctor</Label>
            <select
              id="reschedule-doctor"
              className={SELECT_CLASS}
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
            >
              {bookableDoctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                  {doctor.specialization !== null ? ` · ${doctor.specialization}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reschedule-date">Date</Label>
            <Input
              id="reschedule-date"
              type="date"
              value={selectedDate ?? ""}
              min={minDate}
              max={maxDate}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reschedule-reason">Reason</Label>
          <Textarea
            id="reschedule-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Why is the booking moving?"
          />
        </div>

        {availability.isPending && <p className="text-sm text-muted-foreground">Loading slots…</p>}
        {availability.isError && (
          <Alert variant="destructive">
            <AlertTitle>Slots could not be loaded</AlertTitle>
            <AlertDescription>{errorMessage(availability.error)}</AlertDescription>
          </Alert>
        )}
        {availability.data !== undefined && slots.length === 0 && (
          <p className="text-sm text-muted-foreground">No other bookable slots for this doctor on this date.</p>
        )}

        {slots.length > 0 && (
          <ul className="max-h-56 space-y-2 overflow-y-auto">
            {slots.map((slot) => (
              <li
                key={slot.slotId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="text-sm">
                  <p className="font-medium">{formatTimeRange(slot.startTime, slot.endTime)}</p>
                  <p className="text-muted-foreground">
                    {slot.remaining} {slot.remaining === 1 ? "seat" : "seats"} left
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={move.isPending || !canSubmitReason}
                  title={canSubmitReason ? undefined : "Add a reason first"}
                  onClick={() => move.mutate(slot.slotId)}
                >
                  Move here
                </Button>
              </li>
            ))}
          </ul>
        )}

        {move.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not reschedule</AlertTitle>
            <AlertDescription>{errorMessage(move.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={move.isPending}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
