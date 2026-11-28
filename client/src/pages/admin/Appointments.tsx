import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { apiAdminAppointments, apiDeskQueue, apiPublicClinic, ApiError } from "@/lib/api"
import type { DeskAppointment } from "@/lib/api"
import { clinicToday, formatTimeRange } from "@/lib/clinicDate"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentHistory } from "@/components/appointment-history"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Mode = "day" | "history"

export default function Appointments() {
  const [searchParams] = useSearchParams()
  const wantsHistory =
    ["scope", "from", "to", "search"].some((key) => searchParams.has(key)) ||
    searchParams.get("status") === "NEEDS_ATTENTION"
  const [mode, setMode] = useState<Mode>(wantsHistory ? "history" : "day")

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Appointments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Appointments</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Review the live day board or search appointment history with filters.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant={mode === "day" ? "default" : "outline"} className={mode === "day" ? "" : "bg-white"} onClick={() => setMode("day")}>
            Day view
          </Button>
          <Button variant={mode === "history" ? "default" : "outline"} className={mode === "history" ? "" : "bg-white"} onClick={() => setMode("history")}>
            History
          </Button>
        </div>
      </section>

      {mode === "day" ? <DayView /> : (
        <AppointmentHistory
          fetchAppointments={apiAdminAppointments}
          queryKeyPrefix={["admin", "appointments"]}
        />
      )}
    </div>
  )
}

function DayView() {
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const [date, setDate] = useState("")
  const selectedDate = date !== "" ? date : clinic.data !== undefined ? clinicToday(clinic.data.clinic.timezone) : ""

  const queue = useQuery({
    queryKey: ["staff", "desk", selectedDate],
    queryFn: () => apiDeskQueue(selectedDate).then((result) => result.queue),
    enabled: selectedDate !== "",
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="text-xl text-slate-950">Day board</CardTitle>
            <CardDescription>Live appointments by slot for the selected clinic date.</CardDescription>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-day-date">Date</Label>
            <Input
              id="admin-day-date"
              type="date"
              className="w-full bg-white sm:w-auto"
              value={selectedDate}
              disabled={selectedDate === ""}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {queue.isPending && <PageLoading label="Loading day…" />}
        {queue.isError && (
          <PageError
            title="Day could not be loaded"
            message={queue.error instanceof ApiError ? queue.error.message : undefined}
            onRetry={() => void queue.refetch()}
          />
        )}
        {queue.data?.slots.length === 0 && <EmptyState title="No slots on this date" />}
        {queue.data?.slots.map((slot) => (
          <div key={slot.slotId} className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50/80 px-4 py-3">
              <p className="font-medium text-slate-900">{slot.doctorName}</p>
              <p className="text-sm text-slate-600">
                {formatTimeRange(slot.startTime, slot.endTime)} · {slot.bookedCount}/{slot.maxPatients} booked
              </p>
            </div>
            {slot.appointments.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">No bookings.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {slot.appointments.map((appointment) => (
                  <li key={appointment.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{appointment.patient.fullName}</span>
                        <AppointmentStatusBadge status={appointment.status} />
                      </div>
                      <p className="text-sm text-slate-600">{appointment.patient.phone}</p>
                    </div>
                    <AppointmentActions appointment={appointment as DeskAppointment} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
