import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiAdminAppointments, apiDeskQueue, apiPublicClinic, apiStaffDoctors, ApiError } from "@/lib/api"
import type { AppointmentStatus, DeskAppointment } from "@/lib/api"
import { clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

const STATUSES: AppointmentStatus[] = [
  "PENDING",
  "CONFIRMED",
  "ARRIVED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "NO_SHOW",
]

/**
 * §29's appointment ledger (Day 33).
 *
 * A dated view reuses the front-desk queue so attendance and money actions are
 * the same buttons the desk uses. "All dates" switches to the admin history
 * read, which is filterable but deliberately action-free.
 */
export default function Appointments() {
  const [date, setDate] = useState("")
  const [allDates, setAllDates] = useState(false)
  const [status, setStatus] = useState<AppointmentStatus | "">("")
  const [doctorId, setDoctorId] = useState("")

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: () => apiPublicClinic() })
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: ({ signal }) => apiStaffDoctors(signal) })
  const selectedDate = date !== "" ? date : clinic.data !== undefined ? clinicToday(clinic.data.clinic.timezone) : ""

  const desk = useQuery({
    queryKey: ["staff", "desk", selectedDate],
    queryFn: ({ signal }) => apiDeskQueue(selectedDate, signal).then((result) => result.queue),
    enabled: !allDates && selectedDate !== "",
  })
  const history = useQuery({
    queryKey: ["admin", "appointments", status, doctorId],
    queryFn: ({ signal }) =>
      apiAdminAppointments(
        {
          ...(status !== "" && { status }),
          ...(doctorId !== "" && { doctorId }),
          limit: 100,
        },
        signal,
      ),
    enabled: allDates,
  })

  const deskRows = (desk.data?.slots ?? [])
    .flatMap((slot) => slot.appointments)
    .filter((row) => doctorId === "" || row.doctorId === doctorId)
    .filter((row) => status === "" || row.status === status)
    .sort((a, b) => a.slotStartsAt.localeCompare(b.slotStartsAt))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check a day in or out with the desk actions, or filter the full booking history.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{allDates ? "History" : "Day view"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Date</span>
              <Input
                type="date"
                value={selectedDate}
                disabled={allDates}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Doctor</span>
              <select className={SELECT_CLASS} value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
                <option value="">All doctors</option>
                {doctors.data?.doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Status</span>
              <select
                className={SELECT_CLASS}
                value={status}
                onChange={(event) => setStatus(event.target.value as AppointmentStatus | "")}
              >
                <option value="">All statuses</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll("_", " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={() => setAllDates((value) => !value)}>
              {allDates ? "Back to day view" : "All dates"}
            </Button>
          </div>

          {(allDates ? history : desk).isPending && <PageLoading label="Loading appointments…" />}
          {(allDates ? history : desk).isError && (
            <PageError
              title="Appointments could not be loaded"
              message={
                (allDates ? history.error : desk.error) instanceof ApiError
                  ? ((allDates ? history.error : desk.error) as ApiError).message
                  : undefined
              }
              onRetry={() => void (allDates ? history.refetch() : desk.refetch())}
            />
          )}

          {allDates && history.data?.appointments.length === 0 && (
            <EmptyState title="No appointments match" description="Relax the status or doctor filter." />
          )}
          {!allDates && deskRows.length === 0 && desk.data !== undefined && (
            <EmptyState title="Nothing booked" description={`No appointments on ${selectedDate}.`} />
          )}

          {!allDates && deskRows.length > 0 && (
            <ul className="divide-y">
              {deskRows.map((appointment) => (
                <DeskRow key={appointment.id} appointment={appointment} />
              ))}
            </ul>
          )}

          {allDates && history.data !== undefined && history.data.appointments.length > 0 && (
            <ul className="divide-y">
              {history.data.appointments.map((appointment) => (
                <li key={appointment.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{appointment.patientName}</span>
                      <span className="text-sm text-muted-foreground">{appointment.patientPhone}</span>
                      <AppointmentStatusBadge status={appointment.status} />
                    </div>
                    <p className="text-sm">
                      {appointment.doctorName} · {formatSlotDate(appointment.slotDate)} ·{" "}
                      {formatTimeRange(appointment.startTime, appointment.endTime)}
                    </p>
                  </div>
                  <span className="text-sm text-muted-foreground">{appointment.payment.status.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DeskRow({ appointment }: { appointment: DeskAppointment }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{appointment.patient.fullName}</span>
          <span className="text-sm text-muted-foreground">{appointment.patient.phone}</span>
          <AppointmentStatusBadge status={appointment.status} />
        </div>
        <p className="text-sm">
          {appointment.doctorName} · {formatSlotDate(appointment.slotDate)} ·{" "}
          {formatTimeRange(appointment.startTime, appointment.endTime)}
        </p>
      </div>
      <AppointmentActions appointment={appointment} />
    </li>
  )
}
