import { useQuery } from "@tanstack/react-query"
import { CalendarDays } from "lucide-react"
import { apiDoctorToday, ApiError } from "../../lib/api"
import type { TodaySlotQueue } from "../../lib/api"
import { formatTimeRange } from "../../lib/clinicDate"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * §28's live queue (Day 31) — read-only by construction: there is no attendance
 * verb on the DOCTOR role (§13.1 keeps arrival/no-show work for admin and
 * staff), so this page renders a mirrored server fact and nothing here can act
 * on it.
 *
 * Two kinds of emptiness are shown distinctly:
 * - no slot today (e.g. a Sunday with the seeded template) — honest "no
 *   sessions today", not a loading flash;
 * - slots with nobody booked — each window still renders, empty, so the
 *   doctor sees their actual afternoon rather than a void.
 */
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Today's queue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.date} — {totalInRoom} booking{totalInRoom === 1 ? "" : "s"} across {windows.length} window
          {windows.length === 1 ? "" : "s"}. Read-only: front desk sets attendance.
        </p>
      </div>

      {windows.length === 0 ? (
        <EmptyState
          title="No sessions today"
          description="Your weekly template has no window for today."
        >
          <CalendarDays className="size-4" />
        </EmptyState>
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
    <Card>
      <CardHeader>
        <CardTitle>{formatTimeRange(slot.startTime, slot.endTime)}</CardTitle>
      </CardHeader>
      <CardContent>
        {slot.queue.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bookings in this window.</p>
        ) : (
          <ol className="space-y-2">
            {slot.queue.map((entry) => (
              <li
                key={entry.appointmentId}
                className={
                  entry.upNext
                    ? "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-accent px-4 py-3"
                    : "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.patientName}</span>
                  {entry.upNext && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      Up next
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
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
