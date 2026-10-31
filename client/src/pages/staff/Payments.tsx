import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, HandCoins, Search } from "lucide-react"
import { apiCompleteHandBack, apiDeskHandBacks, apiVisitHistory, ApiError } from "@/lib/api"
import type { DeskHandBack, VisitHistory } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

const HAND_BACK_LABELS: Record<DeskHandBack["kind"], string> = {
  RESCHEDULE_DELTA: "Reschedule delta",
  CANCELLATION: "Cancellation refund",
  CLINIC_CAUSED: "Clinic-caused refund",
  EXPIRED_HOLD: "Expired hold refund",
  CONVERSION_FAILED: "Conversion failed refund",
  DESK_HAND_BACK: "Desk hand-back",
}

/**
 * §17's money desk (Day 32): the physical-refund queue, plus the phone lookup
 * that finds bookings with money still outstanding.
 *
 * Collect and void live beside each booking through `AppointmentActions`; this
 * page exists so the desk can see every refund it owes in one place and record
 * the cash/UPI it physically handed over. Gateway refund retry is ADMIN-only and
 * intentionally absent here.
 */
export default function Payments() {
  const queryClient = useQueryClient()
  const [handBack, setHandBack] = useState<DeskHandBack | null>(null)

  const handBacks = useQuery({
    queryKey: ["staff", "hand-backs"],
    queryFn: () => apiDeskHandBacks().then((result) => result.handBacks),
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments and refunds</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Record money that physically changed hands. Online gateway refunds stay with the gateway.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" /> Desk hand-backs due
          </CardTitle>
        </CardHeader>
        <CardContent>
          {handBacks.isPending && <PageLoading label="Loading hand-backs…" />}
          {handBacks.isError && (
            <PageError
              title="Hand-backs could not be loaded"
              message={handBacks.error instanceof ApiError ? handBacks.error.message : undefined}
              onRetry={() => void handBacks.refetch()}
            />
          )}
          {handBacks.data !== undefined && handBacks.data.length === 0 && (
            <EmptyState
              title="Nothing owed at the desk"
              description="Cancellation and reschedule refunds wait here when the gateway cannot return the money itself."
            >
              <Banknote className="size-4" />
            </EmptyState>
          )}
          {handBacks.data !== undefined && handBacks.data.length > 0 && (
            <ul className="divide-y">
              {handBacks.data.map((entry) => (
                <li key={entry.refundId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{entry.patientName}</span>
                      <Badge variant="outline">{HAND_BACK_LABELS[entry.kind]}</Badge>
                      <span className="text-sm font-medium">{formatPaise(entry.amountPaise, "INR")}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{entry.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      Raised {formatSlotDate(entry.createdAt.slice(0, 10))} · patient {entry.patientId}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => setHandBack(entry)}>
                    Record hand-back
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <OutstandingLookup />

      {handBack !== null && (
        <HandBackDialog
          handBack={handBack}
          onClose={() => setHandBack(null)}
          onDone={() => {
            setHandBack(null)
            void queryClient.invalidateQueries({ queryKey: ["staff"] })
          }}
        />
      )}
    </div>
  )
}

function HandBackDialog({
  handBack,
  onClose,
  onDone,
}: {
  handBack: DeskHandBack
  onClose: () => void
  onDone: () => void
}) {
  const [method, setMethod] = useState<"CASH" | "UPI">("CASH")

  const complete = useMutation({
    mutationFn: () => apiCompleteHandBack(handBack.refundId, method),
    onSuccess: onDone,
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm hand-back</DialogTitle>
          <DialogDescription>
            Record that {formatPaise(handBack.amountPaise, "INR")} was physically returned to {handBack.patientName}.
            This closes the refund queue entry.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <AlertTitle>Only record money already handed over</AlertTitle>
          <AlertDescription>This is an audit record, not a gateway instruction.</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label>Method</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={method === "CASH" ? "default" : "outline"}
              onClick={() => setMethod("CASH")}
            >
              Cash
            </Button>
            <Button
              type="button"
              variant={method === "UPI" ? "default" : "outline"}
              onClick={() => setMethod("UPI")}
            >
              UPI
            </Button>
          </div>
        </div>

        {complete.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not record the hand-back</AlertTitle>
            <AlertDescription>
              {complete.error instanceof ApiError ? complete.error.message : "Try again."}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>
            Close
          </Button>
          <Button onClick={() => complete.mutate()} disabled={complete.isPending}>
            {complete.isPending ? "Recording…" : `Hand back ${method === "CASH" ? "cash" : "via UPI"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OutstandingLookup() {
  const [params] = useSearchParams()
  const initialPhone = params.get("phone") ?? ""
  const [phone, setPhone] = useState(initialPhone)
  const [lookedUpPhone, setLookedUpPhone] = useState<string | null>(null)
  const autoSearched = useRef(false)

  const search = useMutation({
    mutationFn: (value: string) => apiVisitHistory(value).then((result) => result.history),
    onSuccess: (history) => setLookedUpPhone(history.patient?.phone ?? phone.trim()),
  })

  useEffect(() => {
    if (autoSearched.current || initialPhone.trim() === "") return
    autoSearched.current = true
    search.mutate(initialPhone.trim())
  }, [initialPhone, search])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (phone.trim() !== "") search.mutate(phone.trim())
  }

  const history: VisitHistory | undefined = search.data
  const outstanding =
    history?.upcomingAppointments.filter((appointment) => appointment.payment.outstandingPaise > 0) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Find an outstanding balance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="payment-phone">Patient phone</Label>
            <Input
              id="payment-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="off"
              placeholder="98765 43210"
            />
          </div>
          <Button type="submit" disabled={phone.trim() === "" || search.isPending}>
            <Search className="size-4" />
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </form>

        {search.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Lookup failed</AlertTitle>
            <AlertDescription>
              {search.error instanceof ApiError ? search.error.message : "Try again."}
            </AlertDescription>
          </Alert>
        )}

        {history !== undefined && !history.found && (
          <p className="text-sm text-muted-foreground">No patient on file for {lookedUpPhone ?? "that number"}.</p>
        )}

        {history !== undefined && history.found && outstanding.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {history.patient?.fullName ?? "This patient"} has no outstanding balance on upcoming bookings.
          </p>
        )}

        {outstanding.length > 0 && (
          <ul className="divide-y">
            {outstanding.map((appointment) => (
              <li key={appointment.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{appointment.doctorName}</span>
                  <AppointmentStatusBadge status={appointment.status} />
                  <Badge variant="destructive">
                    {formatPaise(appointment.payment.outstandingPaise, "INR")} due
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatSlotDate(appointment.slotDate)} ·{" "}
                  {formatTimeRange(appointment.startTime, appointment.endTime)} · {appointment.patient.fullName}
                </p>
                <AppointmentActions
                  appointment={appointment}
                  onChanged={() => {
                    if (lookedUpPhone !== null) search.mutate(lookedUpPhone)
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
