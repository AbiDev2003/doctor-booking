import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, Users } from "lucide-react"
import { apiDeskQueue, ApiError } from "@/lib/api"
import type { DeskSlotQueue } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

/**
 * §29's front-desk day view (Day 32): every doctor's slots, the live queue in
 * each, and the attendance/payment actions the server says are open.
 *
 * A date picker is included even though the tab is "Today": the clinic day is
 * the server's timezone, and the desk often plans tomorrow while the counter is
 * quiet. Omitting the date asks the server for its own today.
 */
export default function Today() {
  const [pickedDate, setPickedDate] = useState<string | null>(null)

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["staff", "desk", pickedDate ?? "today"],
    queryFn: () => apiDeskQueue(pickedDate ?? undefined).then((result) => result.queue),
  })

  if (isPending) return <PageLoading label="Loading the front desk…" />

  if (isError || data === undefined) {
    return (
      <PageError
        title="The front desk could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => void refetch()}
      />
    )
  }

  const appointments = data.slots.reduce((sum, slot) => sum + slot.appointments.length, 0)
  const arrived = data.slots.reduce(
    (sum, slot) => sum + slot.appointments.filter((entry) => entry.status === "ARRIVED").length,
    0,
  )
  const unpaid = data.slots.reduce(
    (sum, slot) => sum + slot.appointments.filter((entry) => entry.payment.outstandingPaise > 0).length,
    0,
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Front desk</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.date} — {appointments} booking{appointments === 1 ? "" : "s"} across {data.slots.length} slot
            {data.slots.length === 1 ? "" : "s"} · {arrived} checked in · {unpaid} with money outstanding.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="desk-date">Clinic date</Label>
            <Input
              id="desk-date"
              type="date"
              className="h-9"
              value={pickedDate ?? data.date}
              onChange={(event) => setPickedDate(event.target.value === "" ? null : event.target.value)}
            />
          </div>
          <Button variant="outline" onClick={() => setPickedDate(null)} disabled={pickedDate === null}>
            Today
          </Button>
        </div>
      </div>

      {data.slots.length === 0 ? (
        <EmptyState
          title="No slots on this date"
          description="The weekly template produced no windows, or they are all outside the booking horizon."
        >
          <CalendarDays className="size-4" />
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {data.slots.map((slot) => (
            <SlotCard key={slot.slotId} slot={slot} />
          ))}
        </div>
      )}
    </div>
  )
}

function SlotCard({ slot }: { slot: DeskSlotQueue }) {
  const seats = `${slot.bookedCount}/${slot.maxPatients}`

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {slot.doctorName}
            <span className="text-sm font-normal text-muted-foreground">
              {formatSlotDate(slot.slotDate)} · {formatTimeRange(slot.startTime, slot.endTime)}
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {slot.isDisabled && <Badge variant="destructive">Disabled</Badge>}
            <Badge variant={slot.bookedCount >= slot.maxPatients ? "secondary" : "outline"}>
              <Users className="size-3" /> {seats} seats
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {slot.appointments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bookings in this window.</p>
        ) : (
          <ol className="space-y-3">
            {slot.appointments.map((appointment, index) => (
              <li key={appointment.id}>
                {index > 0 && <Separator className="mb-3" />}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{appointment.patient.fullName}</span>
                      <AppointmentStatusBadge status={appointment.status} />
                      {appointment.patient.isProvisional && <Badge variant="outline">Walk-in</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {appointment.patient.phone}
                      {appointment.patient.email !== null ? ` · ${appointment.patient.email}` : ""}
                    </p>
                    <p className="text-sm">
                      Fee {formatPaise(appointment.feeAmount, "INR")} ·{" "}
                      {appointment.payment.status === "PENDING" ? (
                        <span className="text-destructive">
                          {formatPaise(appointment.payment.outstandingPaise, "INR")} outstanding
                        </span>
                      ) : appointment.payment.status === "PAID" ? (
                        <span>
                          {formatPaise(appointment.payment.paidPaise, "INR")} paid
                          {appointment.payment.method !== null ? ` (${appointment.payment.method})` : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Nothing to collect</span>
                      )}
                    </p>
                  </div>
                  <AppointmentActions appointment={appointment} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
