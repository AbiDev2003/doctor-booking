import { useQuery } from "@tanstack/react-query"
import { CalendarDays, Clock, Users } from "lucide-react"
import { apiDoctorToday, ApiError } from "../../lib/api"
import type { TodaySlotQueue } from "../../lib/api"
import { formatTimeRange } from "../../lib/clinicDate"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { PageError, PageLoading } from "@/components/async-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Queue() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["doctor", "today"],
    queryFn: () => apiDoctorToday().then((r) => r.queue),
  })

  if (isPending) return <PageLoading label="Loading today's queue…" />

  if (isError || data === undefined) {
    return (
      <PageError
        title="Your queue could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => void refetch()}
      />
    )
  }

  const windows = data.slots
  const totalInRoom = windows.reduce((sum, slot) => sum + slot.queue.length, 0)

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Live queue</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Today's queue</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          {data.date} — a read-only view of patients booked into today's sessions. Front desk manages attendance.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <div className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-2 text-sm text-slate-700 ring-1 ring-slate-100">
            <Clock className="size-4 text-primary" aria-hidden="true" />
            <span className="font-medium">{windows.length}</span> window{windows.length === 1 ? "" : "s"}
          </div>
          <div className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-2 text-sm text-slate-700 ring-1 ring-slate-100">
            <Users className="size-4 text-primary" aria-hidden="true" />
            <span className="font-medium">{totalInRoom}</span> booking{totalInRoom === 1 ? "" : "s"}
          </div>
        </div>
      </section>

      {windows.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
            <CalendarDays className="size-6" aria-hidden="true" />
          </div>
          <p className="mt-4 text-lg font-semibold text-slate-900">No sessions today</p>
          <p className="mt-2 text-sm text-slate-600">Your weekly template has no window for today.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {windows.map((slot) => (
            <SlotCard key={slot.slotId} slot={slot} />
          ))}
        </div>
      )}
    </div>
  )
}

function SlotCard({ slot }: { slot: TodaySlotQueue }) {
  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg text-slate-950">{formatTimeRange(slot.startTime, slot.endTime)}</CardTitle>
            <CardDescription>
              {slot.queue.length === 0
                ? "No patients booked in this window"
                : `${slot.queue.length} patient${slot.queue.length === 1 ? "" : "s"} booked`}
            </CardDescription>
          </div>
          <span className="inline-flex w-fit items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {slot.queue.length} booked
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {slot.queue.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center text-sm text-slate-500">
            No appointments in this session.
          </div>
        ) : (
          <ol className="space-y-3">
            {slot.queue.map((entry) => (
              <li
                key={entry.appointmentId}
                className={
                  entry.upNext
                    ? "flex flex-col gap-2 rounded-2xl border border-blue-200 bg-blue-50/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    : "flex flex-col gap-2 rounded-2xl bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{entry.patientName}</span>
                  {entry.upNext && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      Up next
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span>{entry.maskedContact}</span>
                  <AppointmentStatusBadge status={entry.status} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
