import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarOff, Clock, Plus, Power, PowerOff } from "lucide-react"
import {
  apiCreateDoctorUnavailability,
  apiCreateSlot,
  apiDoctorUnavailabilities,
  apiPublicClinic,
  apiRemoveUnavailability,
  apiSetSlotDisabled,
  apiSlots,
  apiStaffDoctors,
  apiUpdateSlot,
  ApiError,
} from "@/lib/api"
import type { DoctorUnavailability, Slot } from "@/lib/api"
import { clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { ReasonDialog } from "@/components/staff/reason-dialog"
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
import { Textarea } from "@/components/ui/textarea"

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

type ReasonTarget =
  | { kind: "disable" | "enable"; slot: Slot }
  | { kind: "remove-unavailability"; entry: DoctorUnavailability }

/**
 * §8.4's day-slot surface (Day 32): list a doctor-day's dated slots, create one
 * manually, edit its capacity, and split it out of availability with a reason.
 *
 * Weekly templates are deliberately absent — they stay on the doctor dashboard
 * (Day 31) and are not a desk tool. Doctor create/suspend/archive is also absent;
 * the staff roster is read-only here until Day 33.
 */
export default function Schedule() {
  const queryClient = useQueryClient()
  const [doctorId, setDoctorId] = useState("")
  const [date, setDate] = useState("")
  const [reasonTarget, setReasonTarget] = useState<ReasonTarget | null>(null)
  const [editSlot, setEditSlot] = useState<Slot | null>(null)

  const [startTime, setStartTime] = useState("09:00")
  const [endTime, setEndTime] = useState("09:30")
  const [maxPatients, setMaxPatients] = useState("1")
  const [createReason, setCreateReason] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: () => apiStaffDoctors() })
  const selectedDoctorId =
    doctorId !== "" ? doctorId : (doctors.data?.doctors.find((doctor) => doctor.isBookable)?.id ?? "")
  const selectedDate =
    date !== "" ? date : clinic.data !== undefined ? clinicToday(clinic.data.clinic.timezone) : ""

  const slots = useQuery({
    queryKey: ["staff", "slots", selectedDoctorId, selectedDate],
    queryFn: () => apiSlots(selectedDoctorId, selectedDate).then((result) => result.slots),
    enabled: selectedDoctorId !== "" && selectedDate !== "",
  })

  const unavailabilities = useQuery({
    queryKey: ["staff", "unavailabilities", selectedDoctorId],
    queryFn: () => apiDoctorUnavailabilities(selectedDoctorId).then((result) => result.unavailabilities),
    enabled: selectedDoctorId !== "",
  })

  const create = useMutation({
    mutationFn: () =>
      apiCreateSlot({
        doctorId: selectedDoctorId,
        slotDate: selectedDate,
        startTime,
        endTime,
        maxPatients: Number(maxPatients),
        ...(createReason.trim() !== "" && { reason: createReason.trim() }),
      }),
    onSuccess: (result) => {
      setNotice(result.message)
      setCreateReason("")
      void queryClient.invalidateQueries({ queryKey: ["staff", "slots"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    },
  })

  const split = useMutation({
    mutationFn: ({ target, reason }: { target: ReasonTarget; reason: string }) => {
      if (target.kind === "remove-unavailability") {
        return apiRemoveUnavailability(target.entry.id, reason)
      }
      return apiSetSlotDisabled(target.slot.id, target.kind === "enable", reason)
    },
    onSuccess: () => {
      setReasonTarget(null)
      void queryClient.invalidateQueries({ queryKey: ["staff"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    },
  })

  if (clinic.isPending || doctors.isPending) return <PageLoading label="Loading doctors…" />

  if (clinic.isError || doctors.isError) {
    const error = clinic.error ?? doctors.error
    return (
      <PageError
        title="Schedule options could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => {
          void clinic.refetch()
          void doctors.refetch()
        }}
      />
    )
  }

  const doctorOptions = doctors.data.doctors.filter((doctor) => doctor.isBookable)
  const createError = create.error instanceof ApiError ? create.error.message : undefined
  const slotRows = slots.data ?? []
  const unavailabilityRows = unavailabilities.data ?? []

  function submitCreate(event: FormEvent) {
    event.preventDefault()
    setNotice(null)
    create.mutate()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Day schedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage one doctor-day at a time. Every change carries a reason and an audit entry.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="schedule-doctor">Doctor</Label>
            <select
              id="schedule-doctor"
              className={SELECT_CLASS}
              value={selectedDoctorId}
              onChange={(event) => setDoctorId(event.target.value)}
            >
              {doctorOptions.length === 0 && <option value="">No verified doctors available</option>}
              {doctorOptions.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                  {doctor.specialization !== null ? ` · ${doctor.specialization}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="schedule-date">Date</Label>
            <Input
              id="schedule-date"
              type="date"
              value={selectedDate}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {notice !== null && (
        <Alert>
          <AlertTitle>Schedule updated</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="size-4" /> Slots on {formatSlotDate(selectedDate)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {slots.isPending && selectedDoctorId !== "" && <PageLoading label="Loading slots…" />}
          {slots.isError && (
            <PageError
              title="Slots could not be loaded"
              message={slots.error instanceof ApiError ? slots.error.message : undefined}
              onRetry={() => void slots.refetch()}
            />
          )}
          {slots.data !== undefined && slotRows.length === 0 && (
            <EmptyState
              title="No slots on this date"
              description="Create one manually below, or adjust the weekly template on the doctor dashboard."
            >
              <Clock className="size-4" />
            </EmptyState>
          )}

          {slotRows.length > 0 && (
            <ul className="divide-y">
              {slotRows.map((slot) => (
                <li key={slot.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {formatTimeRange(slot.startTime, slot.endTime)}
                      </span>
                      <Badge variant={slot.isDisabled ? "destructive" : "outline"}>
                        {slot.isDisabled ? "Disabled" : "Bookable"}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {slot.bookedCount}/{slot.maxPatients} booked
                        {slot.heldCount > 0 ? ` · ${slot.heldCount} held` : ""}
                      </span>
                    </div>
                    {slot.isDisabled && slot.disabledReason !== null && (
                      <p className="text-sm text-muted-foreground">{slot.disabledReason}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditSlot(slot)}>
                      Edit capacity
                    </Button>
                    <Button
                      size="sm"
                      variant={slot.isDisabled ? "secondary" : "outline"}
                      onClick={() =>
                        setReasonTarget({ kind: slot.isDisabled ? "enable" : "disable", slot })
                      }
                    >
                      {slot.isDisabled ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                      {slot.isDisabled ? "Enable" : "Disable"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitCreate} className="space-y-3 rounded-lg border p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Plus className="size-4" /> Add a slot
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="slot-start">Start</Label>
                <Input
                  id="slot-start"
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slot-end">End</Label>
                <Input
                  id="slot-end"
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slot-capacity">Seats</Label>
                <Input
                  id="slot-capacity"
                  type="number"
                  min="1"
                  max="1000"
                  value={maxPatients}
                  onChange={(event) => setMaxPatients(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="slot-reason">Reason (optional on create)</Label>
              <Textarea
                id="slot-reason"
                rows={2}
                maxLength={1000}
                value={createReason}
                onChange={(event) => setCreateReason(event.target.value)}
              />
            </div>
            {createError !== undefined && (
              <Alert variant="destructive">
                <AlertTitle>Could not create the slot</AlertTitle>
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              disabled={
                create.isPending ||
                selectedDoctorId === "" ||
                startTime === "" ||
                endTime === "" ||
                !Number.isInteger(Number(maxPatients)) ||
                Number(maxPatients) < 1
              }
            >
              {create.isPending ? "Creating…" : "Create slot"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <UnavailabilityCard
        doctorId={selectedDoctorId}
        rows={unavailabilityRows}
        isPending={unavailabilities.isPending}
        isError={unavailabilities.isError}
        error={unavailabilities.error}
        onRetry={() => void unavailabilities.refetch()}
        onRemove={(entry) => setReasonTarget({ kind: "remove-unavailability", entry })}
      />

      {editSlot !== null && (
        <EditSlotDialog
          slot={editSlot}
          onClose={() => setEditSlot(null)}
          onSaved={() => {
            setEditSlot(null)
            void queryClient.invalidateQueries({ queryKey: ["staff", "slots"] })
            void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
          }}
        />
      )}

      <ReasonDialog
        open={reasonTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReasonTarget(null)
        }}
        title={
          reasonTarget?.kind === "disable"
            ? "Disable this slot"
            : reasonTarget?.kind === "enable"
              ? "Enable this slot"
              : "Remove this unavailability"
        }
        description={
          reasonTarget?.kind === "disable"
            ? "New bookings stop immediately. The server refuses while a booking or live hold still depends on the slot."
            : reasonTarget?.kind === "enable"
              ? "The slot becomes bookable again. The reason is mandatory and audited."
              : "The disruption is removed and the hidden slots reopen. The reason is mandatory and audited."
        }
        confirmLabel={
          reasonTarget?.kind === "disable"
            ? "Disable slot"
            : reasonTarget?.kind === "enable"
              ? "Enable slot"
              : "Remove unavailability"
        }
        pending={split.isPending}
        error={split.error instanceof ApiError ? split.error.message : undefined}
        onConfirm={(value) => {
          if (reasonTarget !== null) split.mutate({ target: reasonTarget, reason: value })
        }}
      />
    </div>
  )
}

function EditSlotDialog({
  slot,
  onClose,
  onSaved,
}: {
  slot: Slot
  onClose: () => void
  onSaved: () => void
}) {
  const [capacity, setCapacity] = useState(String(slot.maxPatients))
  const [reason, setReason] = useState("")

  const update = useMutation({
    mutationFn: () => apiUpdateSlot(slot.id, { maxPatients: Number(capacity), reason: reason.trim() }),
    onSuccess: onSaved,
  })

  const invalid =
    !Number.isInteger(Number(capacity)) || Number(capacity) < 1 || Number(capacity) > 1000 || reason.trim() === ""

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit slot capacity</DialogTitle>
          <DialogDescription>
            {formatSlotDate(slot.slotDate)} · {formatTimeRange(slot.startTime, slot.endTime)}. Capacity cannot fall
            below the seats already booked or held.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="edit-capacity">Seats</Label>
          <Input
            id="edit-capacity"
            type="number"
            min="1"
            max="1000"
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-reason">Reason</Label>
          <Textarea
            id="edit-reason"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>

        {update.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not update the slot</AlertTitle>
            <AlertDescription>
              {update.error instanceof ApiError ? update.error.message : "Try again."}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Close
          </Button>
          <Button onClick={() => update.mutate()} disabled={update.isPending || invalid}>
            {update.isPending ? "Saving…" : "Save capacity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UnavailabilityCard({
  doctorId,
  rows,
  isPending,
  isError,
  error,
  onRetry,
  onRemove,
}: {
  doctorId: string
  rows: DoctorUnavailability[]
  isPending: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  onRemove: (entry: DoctorUnavailability) => void
}) {
  const queryClient = useQueryClient()
  const [date, setDate] = useState("")
  const [startTime, setStartTime] = useState("13:00")
  const [endTime, setEndTime] = useState("14:00")
  const [reason, setReason] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      apiCreateDoctorUnavailability({ doctorId, date, startTime, endTime, reason: reason.trim() }),
    onSuccess: (result) => {
      setNotice(
        result.affectedCount === 0
          ? result.message
          : `${result.message} ${result.affectedCount} existing booking${result.affectedCount === 1 ? " was" : "s were"} flagged.`,
      )
      setReason("")
      void queryClient.invalidateQueries({ queryKey: ["staff"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    },
  })

  const invalid =
    doctorId === "" || date === "" || startTime === "" || endTime === "" || reason.trim() === ""

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarOff className="size-4" /> Unavailability
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending && doctorId !== "" && <PageLoading label="Loading disruptions…" />}
        {isError && (
          <PageError
            title="Unavailability could not be loaded"
            message={error instanceof ApiError ? error.message : undefined}
            onRetry={onRetry}
          />
        )}
        {rows.length === 0 && !isPending && (
          <p className="text-sm text-muted-foreground">No disruption windows for this doctor.</p>
        )}
        {rows.length > 0 && (
          <ul className="divide-y">
            {rows.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="space-y-1">
                  <p className="font-medium">
                    {formatSlotDate(entry.date)} · {formatTimeRange(entry.startTime, entry.endTime)}
                  </p>
                  <p className="text-sm text-muted-foreground">{entry.reason}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onRemove(entry)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault()
            setNotice(null)
            create.mutate()
          }}
          className="space-y-3 rounded-lg border p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <Plus className="size-4" /> Add unavailability
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="unavailable-date">Date</Label>
              <Input
                id="unavailable-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unavailable-start">Start</Label>
              <Input
                id="unavailable-start"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unavailable-end">End</Label>
              <Input
                id="unavailable-end"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="unavailable-reason">Reason</Label>
            <Textarea
              id="unavailable-reason"
              rows={2}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {notice !== null && (
            <Alert>
              <AlertTitle>Unavailability recorded</AlertTitle>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          {create.error !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not record unavailability</AlertTitle>
              <AlertDescription>
                {create.error instanceof ApiError ? create.error.message : "Try again."}
              </AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={create.isPending || invalid}>
            {create.isPending ? "Saving…" : "Mark unavailable"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
