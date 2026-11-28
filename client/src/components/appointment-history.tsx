import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { apiStaffDoctors, ApiError } from "@/lib/api"
import type { AppointmentHistoryQuery, AppointmentHistoryRow, AppointmentStatus } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
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

export type AppointmentHistoryScope = NonNullable<AppointmentHistoryQuery["scope"]>

const SCOPES: { value: AppointmentHistoryScope; label: string }[] = [
  { value: "all", label: "All bookings" },
  { value: "upcoming", label: "Upcoming" },
  { value: "past", label: "Past" },
  { value: "needsAttention", label: "Needs attention" },
]

/**
 * The clinic-wide appointment History, shared by the admin and staff dashboards.
 *
 * Filters, rows and action buttons are identical on both surfaces: they come
 * from the same server query and the same server-computed action flags. The
 * caller only supplies the fetcher and a query-key prefix so React Query
 * invalidations stay scoped to the dashboard that made the request.
 */
export function AppointmentHistory({
  fetchAppointments,
  queryKeyPrefix,
}: {
  fetchAppointments: (
    input: AppointmentHistoryQuery,
    signal?: AbortSignal,
  ) => Promise<{ appointments: AppointmentHistoryRow[] }>
  queryKeyPrefix: readonly unknown[]
}) {
  const [searchParams] = useSearchParams()
  const statusFromUrl = searchParams.get("status")
  const scopeFromUrl = searchParams.get("scope")

  const [scope, setScope] = useState<AppointmentHistoryScope>(() => {
    if (
      scopeFromUrl === "all" ||
      scopeFromUrl === "upcoming" ||
      scopeFromUrl === "past" ||
      scopeFromUrl === "needsAttention"
    ) {
      return scopeFromUrl
    }
    return statusFromUrl === "NEEDS_ATTENTION" ? "needsAttention" : "all"
  })
  const [status, setStatus] = useState<AppointmentStatus | "">(
    statusFromUrl === null || statusFromUrl === "NEEDS_ATTENTION" ? "" : (statusFromUrl as AppointmentStatus),
  )
  const [doctorId, setDoctorId] = useState("")
  const [date, setDate] = useState(searchParams.get("date") ?? "")
  const [from, setFrom] = useState(searchParams.get("from") ?? "")
  const [to, setTo] = useState(searchParams.get("to") ?? "")
  const [search, setSearch] = useState(searchParams.get("search") ?? "")

  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: ({ signal }) => apiStaffDoctors(signal) })
  const appointments = useQuery({
    queryKey: [...queryKeyPrefix, scope, doctorId, status, date, from, to, search],
    queryFn: ({ signal }) =>
      fetchAppointments(
        {
          ...(scope !== "all" && { scope }),
          ...(doctorId !== "" && { doctorId }),
          ...(status !== "" && { status }),
          ...(date !== "" && { date }),
          ...(from !== "" && { from }),
          ...(to !== "" && { to }),
          ...(search !== "" && { search }),
          limit: 100,
        },
        signal,
      ),
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-950">History</CardTitle>
        <CardDescription>Filter every booking across doctors and close anything still open.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="history-scope">Scope</Label>
            <select
              id="history-scope"
              className={SELECT_CLASS}
              value={scope}
              onChange={(event) => setScope(event.target.value as AppointmentHistoryScope)}
            >
              {SCOPES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
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
            <select
              id="history-status"
              className={SELECT_CLASS}
              value={status}
              onChange={(event) => setStatus(event.target.value as AppointmentStatus | "")}
            >
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="history-date">Exact date</Label>
            <Input id="history-date" type="date" className="bg-white" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="history-from">From</Label>
            <Input id="history-from" type="date" className="bg-white" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="history-to">To</Label>
            <Input id="history-to" type="date" className="bg-white" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2 xl:col-span-3">
            <Label htmlFor="history-search">Patient name or phone</Label>
            <Input
              id="history-search"
              className="bg-white"
              placeholder="Search patients…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
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
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th scope="col" className="py-3 pr-3 font-medium">When</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Patient</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Doctor</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Payment</th>
                  <th scope="col" className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {appointments.data.appointments.map((appointment) => (
                  <tr key={appointment.id} className="align-top">
                    <td className="py-3 pr-3 text-slate-600">
                      <div className="font-medium text-slate-900">{formatSlotDate(appointment.slotDate)}</div>
                      <div>{formatTimeRange(appointment.startTime, appointment.endTime)}</div>
                    </td>
                    <td className="py-3 pr-3 text-slate-900">
                      <div>{appointment.patientName}</div>
                      <div className="text-xs text-slate-500">{appointment.patientPhone}</div>
                    </td>
                    <td className="py-3 pr-3 text-slate-600">{appointment.doctorName}</td>
                    <td className="py-3 pr-3"><AppointmentStatusBadge status={appointment.status} /></td>
                    <td className="py-3 pr-3 text-slate-600">
                      {appointment.payment.status === "PENDING"
                        ? `Due ${formatPaise(appointment.payment.outstandingPaise, "INR")}`
                        : appointment.payment.status}
                    </td>
                    <td className="py-3"><AppointmentActions appointment={appointment} /></td>
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
