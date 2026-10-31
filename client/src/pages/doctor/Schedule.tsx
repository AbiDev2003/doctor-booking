import { useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, CalendarOff, CheckCircle2, Pencil, Plus, Trash2 } from "lucide-react"
import { useSession } from "../../hooks/useSession"
import {
  apiCreateScheduleWindow,
  apiCreateUnavailability,
  apiDeleteScheduleWindow,
  apiMySchedules,
  apiMyUnavailabilities,
  apiPublicClinic,
  apiRemoveUnavailability,
  apiUpdateScheduleWindow,
  ApiError,
} from "../../lib/api"
import type {
  CreateScheduleWindowInput,
  DoctorUnavailability,
  MaterializeStats,
  ScheduleWindow,
  Weekday,
} from "../../lib/api"
import { clinicToday, formatSlotDate, formatTimeRange } from "../../lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

/**
 * §28's schedule + availability editor (Day 31).
 *
 * Two surfaces over the existing server CRUD:
 * - **Weekly template** — the recurring windows that generate slots (§11).
 *   A DOCTOR may create their own window (including `maxPatients`), move the
 *   weekday/times, and delete it with a reason. `maxPatients` is read-only on
 *   edit because the server refuses a DOCTOR changing capacity (§8.3).
 * - **Time off** — `DoctorUnavailability` windows (§12), not slot mutation.
 *   Slots stay ADMIN/STAFF-only; marking time off is the doctor's availability
 *   tool. The server reports how many CONFIRMED bookings it flagged.
 *
 * Deletes never touch already-generated slots (§11); the confirm dialog says so
 * rather than letting a doctor assume bookings vanished with the window.
 */

const WEEKDAYS: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

const WEEKDAY_LABEL: Record<Weekday, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

function materializedNote(stats: MaterializeStats | null): string {
  if (stats === null) return ""
  if (stats.created > 0) return ` ${stats.created} new slot${stats.created === 1 ? "" : "s"} generated.`
  return " No new slots were needed."
}

export default function Schedule() {
  const { user } = useSession()
  return <ScheduleEditor doctorId={user?.id ?? ""} />
}

export function ScheduleEditor({
  doctorId,
  title = "Schedule",
  description = "Your recurring windows generate slots. Time off hides and flags affected bookings.",
}: {
  doctorId: string
  title?: string
  description?: string
}) {
  const queryClient = useQueryClient()

  const [notice, setNotice] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ScheduleWindow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ScheduleWindow | null>(null)
  const [timeOffOpen, setTimeOffOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<DoctorUnavailability | null>(null)
  const [showPast, setShowPast] = useState(false)
  // Captured once at mount: a stable "now" for the upcoming/past split.
  const [now] = useState(() => Date.now())

  const schedules = useQuery({
    queryKey: ["doctor", "schedule", doctorId],
    queryFn: () => apiMySchedules(doctorId).then((result) => result.schedules),
    enabled: doctorId !== "",
  })
  const timeOff = useQuery({
    queryKey: ["doctor", "unavailabilities", doctorId],
    queryFn: () => apiMyUnavailabilities(doctorId).then((result) => result.unavailabilities),
    enabled: doctorId !== "",
  })
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })

  if (schedules.isPending || timeOff.isPending || clinic.isPending) {
    return <PageLoading label="Loading your schedule…" />
  }

  if (schedules.isError || timeOff.isError || clinic.isError) {
    const error = schedules.error ?? timeOff.error ?? clinic.error
    return (
      <PageError
        title="Your schedule could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => {
          void schedules.refetch()
          void timeOff.refetch()
          void clinic.refetch()
        }}
      />
    )
  }

  function invalidateSchedule() {
    void queryClient.invalidateQueries({ queryKey: ["doctor", "schedule", doctorId] })
    void queryClient.invalidateQueries({ queryKey: ["doctor", "today"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    void queryClient.invalidateQueries({ queryKey: ["admin"] })
  }

  function invalidateTimeOff() {
    void queryClient.invalidateQueries({ queryKey: ["doctor", "unavailabilities", doctorId] })
    void queryClient.invalidateQueries({ queryKey: ["doctor", "today"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    void queryClient.invalidateQueries({ queryKey: ["admin"] })
  }

  const windows = [...schedules.data].sort(
    (a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) || a.startTime.localeCompare(b.startTime),
  )
  const upcomingTimeOff = timeOff.data
    .filter((row) => new Date(row.endAt).getTime() >= now)
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
  const pastTimeOff = timeOff.data
    .filter((row) => new Date(row.endAt).getTime() < now)
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
  const defaultDate = clinicToday(clinic.data.clinic.timezone)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {notice !== null && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="template">
        <TabsList>
          <TabsTrigger value="template">Weekly template</TabsTrigger>
          <TabsTrigger value="timeoff">Time off</TabsTrigger>
        </TabsList>

        <TabsContent value="template" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-xl text-sm text-muted-foreground">
              Changes apply to dates not yet generated. Removing a window does not delete existing slots or bookings.
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Add window
            </Button>
          </div>

          {windows.length === 0 ? (
            <EmptyState
              title="No weekly windows yet"
              description="Add a recurring window so patients can book you."
            >
              <CalendarDays className="size-4" />
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {WEEKDAYS.map((day) => {
                const dayWindows = windows.filter((window) => window.weekday === day)
                if (dayWindows.length === 0) return null
                return (
                  <Card key={day}>
                    <CardHeader>
                      <CardTitle>{WEEKDAY_LABEL[day]}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {dayWindows.map((window) => (
                        <div
                          key={window.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
                        >
                          <div>
                            <p className="font-medium">{formatTimeRange(window.startTime, window.endTime)}</p>
                            <p className="text-sm text-muted-foreground">
                              Up to {window.maxPatients} patient{window.maxPatients === 1 ? "" : "s"} per slot
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={() => setEditTarget(window)}>
                              <Pencil /> Edit
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(window)}>
                              <Trash2 /> Delete
                            </Button>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="timeoff" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-xl text-sm text-muted-foreground">
              Mark a period you cannot work. Affected confirmed patients are flagged and can cancel with a full refund.
            </p>
            <Button size="sm" onClick={() => setTimeOffOpen(true)}>
              <CalendarOff /> Mark time off
            </Button>
          </div>

          {upcomingTimeOff.length === 0 && pastTimeOff.length === 0 ? (
            <EmptyState title="No time off recorded" description="Your windows stay bookable until you add one." />
          ) : (
            <div className="space-y-4">
              {upcomingTimeOff.length > 0 && (
                <TimeOffList title="Upcoming" rows={upcomingTimeOff} onRemove={setRemoveTarget} />
              )}

              {pastTimeOff.length > 0 && (
                <div className="space-y-2">
                  <Button variant="link" size="sm" className="px-0" onClick={() => setShowPast((value) => !value)}>
                    {showPast ? "Hide past time off" : `Show past time off (${pastTimeOff.length})`}
                  </Button>
                  {showPast && <TimeOffList title="Past" rows={pastTimeOff} onRemove={setRemoveTarget} />}
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {createOpen && (
        <CreateScheduleDialog
          doctorId={doctorId}
          onClose={() => setCreateOpen(false)}
          onDone={(message) => {
            invalidateSchedule()
            setNotice(message)
          }}
        />
      )}

      {editTarget !== null && (
        <EditScheduleDialog
          window={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={(message) => {
            invalidateSchedule()
            setNotice(message)
          }}
        />
      )}

      {deleteTarget !== null && (
        <DeleteScheduleDialog
          window={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={(message) => {
            invalidateSchedule()
            setNotice(message)
          }}
        />
      )}

      {timeOffOpen && (
        <CreateTimeOffDialog
          doctorId={doctorId}
          defaultDate={defaultDate}
          onClose={() => setTimeOffOpen(false)}
          onDone={(message) => {
            invalidateTimeOff()
            setNotice(message)
          }}
        />
      )}

      {removeTarget !== null && (
        <RemoveTimeOffDialog
          row={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onDone={(message) => {
            invalidateTimeOff()
            setNotice(message)
          }}
        />
      )}
    </div>
  )
}

function TimeOffList({
  title,
  rows,
  onRemove,
}: {
  title: string
  rows: readonly DoctorUnavailability[]
  onRemove: (row: DoctorUnavailability) => void
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
          >
            <div>
              <p className="font-medium">
                {formatSlotDate(row.date)} · {formatTimeRange(row.startTime, row.endTime)}
              </p>
              <p className="text-sm text-muted-foreground">{row.reason}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onRemove(row)}>
              <Trash2 /> Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function DialogError({ error }: { error: string | null }) {
  if (error === null) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not save</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

function CreateScheduleDialog({
  doctorId,
  onClose,
  onDone,
}: {
  doctorId: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [weekday, setWeekday] = useState<Weekday>("MON")
  const [startTime, setStartTime] = useState("09:00")
  const [endTime, setEndTime] = useState("13:00")
  const [maxPatients, setMaxPatients] = useState("10")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (input: CreateScheduleWindowInput) => apiCreateScheduleWindow(input),
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (endTime <= startTime) {
      setError("End time must be after start time (windows cannot run overnight).")
      return
    }
    try {
      const result = await mutation.mutateAsync({
        doctorId,
        weekday,
        startTime,
        endTime,
        maxPatients: Number(maxPatients),
        ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      })
      onDone(`Window added.${materializedNote(result.materialized)}`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a weekly window</DialogTitle>
          <DialogDescription>This repeats every week and generates slots for future dates.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Weekday" htmlFor="schedule-weekday">
              <select
                id="schedule-weekday"
                className={SELECT_CLASS}
                value={weekday}
                onChange={(event) => setWeekday(event.target.value as Weekday)}
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>
                    {WEEKDAY_LABEL[day]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Max patients per slot" htmlFor="schedule-capacity">
              <Input
                id="schedule-capacity"
                type="number"
                min={1}
                max={1000}
                required
                value={maxPatients}
                onChange={(event) => setMaxPatients(event.target.value)}
              />
            </Field>

            <Field label="Start time" htmlFor="schedule-start">
              <Input
                id="schedule-start"
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>

            <Field label="End time" htmlFor="schedule-end">
              <Input
                id="schedule-end"
                type="time"
                required
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Reason (optional)" htmlFor="schedule-reason">
            <Textarea
              id="schedule-reason"
              rows={2}
              maxLength={1000}
              placeholder="Why this window is being added"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <DialogError error={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Adding…" : "Add window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditScheduleDialog({
  window,
  onClose,
  onDone,
}: {
  window: ScheduleWindow
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [weekday, setWeekday] = useState<Weekday>(window.weekday)
  const [startTime, setStartTime] = useState(window.startTime.slice(0, 5))
  const [endTime, setEndTime] = useState(window.endTime.slice(0, 5))
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => apiUpdateScheduleWindow(window.id, { weekday, startTime, endTime, reason: reason.trim() }),
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (reason.trim() === "") {
      setError("A reason is required for changes.")
      return
    }
    if (endTime <= startTime) {
      setError("End time must be after start time (windows cannot run overnight).")
      return
    }
    try {
      const result = await mutation.mutateAsync()
      onDone(`Window updated.${materializedNote(result.materialized)}`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit weekly window</DialogTitle>
          <DialogDescription>Existing slots are unchanged; the edit applies to future generation.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Weekday" htmlFor="edit-weekday">
              <select
                id="edit-weekday"
                className={SELECT_CLASS}
                value={weekday}
                onChange={(event) => setWeekday(event.target.value as Weekday)}
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>
                    {WEEKDAY_LABEL[day]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Max patients per slot" htmlFor="edit-capacity">
              <Input id="edit-capacity" type="number" value={window.maxPatients} disabled readOnly />
            </Field>

            <Field label="Start time" htmlFor="edit-start">
              <Input
                id="edit-start"
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>

            <Field label="End time" htmlFor="edit-end">
              <Input
                id="edit-end"
                type="time"
                required
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>

          <p className="text-sm text-muted-foreground">
            Capacity is clinic configuration — ask the front desk to change it.
          </p>

          <Field label="Reason (required)" htmlFor="edit-reason">
            <Textarea
              id="edit-reason"
              rows={2}
              required
              maxLength={1000}
              placeholder="Why this window is changing"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <DialogError error={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Keep as is
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteScheduleDialog({
  window,
  onClose,
  onDone,
}: {
  window: ScheduleWindow
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => apiDeleteScheduleWindow(window.id, reason.trim()),
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (reason.trim() === "") {
      setError("A reason is required to remove a window.")
      return
    }
    try {
      const result = await mutation.mutateAsync()
      onDone(`Window removed.${materializedNote(result.materialized)}`)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this window?</DialogTitle>
          <DialogDescription>
            {WEEKDAY_LABEL[window.weekday]} · {formatTimeRange(window.startTime, window.endTime)}. Existing generated
            slots and their bookings are unchanged — only future dates stop gaining slots.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Reason (required)" htmlFor="delete-reason">
            <Textarea
              id="delete-reason"
              rows={2}
              required
              maxLength={1000}
              placeholder="Why this window is being removed"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <DialogError error={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Keep window
            </Button>
            <Button type="submit" variant="destructive" disabled={mutation.isPending}>
              {mutation.isPending ? "Removing…" : "Remove window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CreateTimeOffDialog({
  doctorId,
  defaultDate,
  onClose,
  onDone,
}: {
  doctorId: string
  defaultDate: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState("09:00")
  const [endTime, setEndTime] = useState("13:00")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => apiCreateUnavailability({ doctorId, date, startTime, endTime, reason: reason.trim() }),
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (reason.trim() === "") {
      setError("A reason is required for time off.")
      return
    }
    if (endTime <= startTime) {
      setError("End time must be after start time.")
      return
    }
    try {
      const result = await mutation.mutateAsync()
      onDone(
        result.affectedCount > 0
          ? `Time off saved. ${result.affectedCount} confirmed booking${result.affectedCount === 1 ? "" : "s"} flagged — affected patients can cancel with a full refund.`
          : "Time off saved. No confirmed bookings were affected.",
      )
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark time off</DialogTitle>
          <DialogDescription>
            This closes the window for booking and flags any confirmed patients inside it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date" htmlFor="timeoff-date">
              <Input
                id="timeoff-date"
                type="date"
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </Field>

            <Field label="From" htmlFor="timeoff-start">
              <Input
                id="timeoff-start"
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </Field>

            <Field label="To" htmlFor="timeoff-end">
              <Input
                id="timeoff-end"
                type="time"
                required
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Reason (required)" htmlFor="timeoff-reason">
            <Textarea
              id="timeoff-reason"
              rows={2}
              required
              maxLength={1000}
              placeholder="e.g. surgery, personal leave"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <DialogError error={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save time off"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveTimeOffDialog({
  row,
  onClose,
  onDone,
}: {
  row: DoctorUnavailability
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => apiRemoveUnavailability(row.id, reason.trim()),
  })

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (reason.trim() === "") {
      setError("A reason is required to remove time off.")
      return
    }
    try {
      await mutation.mutateAsync()
      onDone("Time off removed. The window is bookable again.")
      onClose()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove time off?</DialogTitle>
          <DialogDescription>
            {formatSlotDate(row.date)} · {formatTimeRange(row.startTime, row.endTime)} — {row.reason}. This reopens the
            window; it can only be removed while no appointment references it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Reason (required)" htmlFor="remove-timeoff-reason">
            <Textarea
              id="remove-timeoff-reason"
              rows={2}
              required
              maxLength={1000}
              placeholder="Why this time off is being removed"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <DialogError error={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Keep time off
            </Button>
            <Button type="submit" variant="destructive" disabled={mutation.isPending}>
              {mutation.isPending ? "Removing…" : "Remove time off"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
