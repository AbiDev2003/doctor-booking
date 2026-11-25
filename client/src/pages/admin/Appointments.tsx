import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiAdminAppointments, apiDeskQueue, apiPublicClinic, apiStaffDoctors, ApiError } from "@/lib/api"
import type { AppointmentStatus, DeskAppointment } from "@/lib/api"
import { clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-auto"

const STATUSES: AppointmentStatus[] = [
  "PENDING",
  "CONFIRMED",
  "ARRIVED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "NO_SHOW",
]

type Mode = "day" | "history"

export default function Appointments() {
  const [mode, setMode] = useState<Mode>("day")

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

      {mode === "day" ? <DayView /> : <HistoryView />}
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

function HistoryView() {
  const [doctorId, setDoctorId] = useState("")
  const [status, setStatus] = useState<AppointmentStatus | "">("")
  const [date, setDate] = useState("")

  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: ({ signal }) => apiStaffDoctors(signal) })
  const appointments = useQuery({
    queryKey: ["admin", "appointments", doctorId, status, date],
    queryFn: ({ signal }) =>
      apiAdminAppointments(
        {
          ...(doctorId !== "" && { doctorId }),
          ...(status !== "" && { status }),
          ...(date !== "" && { date }),
          limit: 100,
        },
        signal,
      ),
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-950">History</CardTitle>
        <CardDescription>Filter past and current appointments across doctors.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="history-doctor">Doctor</Label>
            <select id="history-doctor" className={SELECT_CLASS} value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
              <option value="">All doctors</option>
              {doctors.data?.doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="history-status">Status</Label>
            <select id="history-status" className={SELECT_CLASS} value={status} onChange={(event) => setStatus(event.target.value as AppointmentStatus | "")}>
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="history-date">Date</Label>
            <Input id="history-date" type="date" className="bg-white" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
        </div>

        {appointments.isPending && <PageLoading label="Loading appointments…" />}
        {appointments.isError && (
          <PageError
            title="Appointments could not be loaded"
            message={appointments.error instanceof ApiError ? appointments.error.message : undefined}
            onRetry={() => void appointments.refetch()}
          />
        )}
        {appointments.data?.appointments.length === 0 && <EmptyState title="No appointments match" />}
        {appointments.data !== undefined && appointments.data.appointments.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th scope="col" className="py-3 pr-3 font-medium">When</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Patient</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Doctor</th>
                  <th scope="col" className="py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {appointments.data.appointments.map((appointment) => (
                  <tr key={appointment.id} className="align-top">
                    <td className="py-3 pr-3 text-slate-600">
                      <div className="font-medium text-slate-900">{formatSlotDate(appointment.slotDate)}</div>
                      <div>{formatTimeRange(appointment.startTime, appointment.endTime)}</div>
                    </td>
                    <td className="py-3 pr-3 text-slate-900">{appointment.patientName}</td>
                    <td className="py-3 pr-3 text-slate-600">{appointment.doctorName}</td>
                    <td className="py-3"><AppointmentStatusBadge status={appointment.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
