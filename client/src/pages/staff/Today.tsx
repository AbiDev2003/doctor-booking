import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, Users } from "lucide-react"
import { apiDeskQueue, ApiError } from "@/lib/api"
import type { DeskSlotQueue } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

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
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Front desk</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Today’s desk</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              {formatSlotDate(data.date)} — {appointments} booking{appointments === 1 ? "" : "s"} across {data.slots.length} slot
              {data.slots.length === 1 ? "" : "s"}, {arrived} checked in, {unpaid} with money outstanding.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-2">
              <Label htmlFor="desk-date" className="text-slate-700">Clinic date</Label>
              <Input
                id="desk-date"
                type="date"
                className="h-10 w-auto bg-white"
                value={pickedDate ?? data.date}
                onChange={(event) => setPickedDate(event.target.value === "" ? null : event.target.value)}
              />
            </div>
            <Button variant="outline" className="bg-white" onClick={() => setPickedDate(null)} disabled={pickedDate === null}>
              Today
            </Button>
          </div>
        </div>
      </section>

      {data.slots.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
            <CalendarDays className="size-6" aria-hidden="true" />
          </div>
          <p className="mt-4 text-lg font-semibold text-slate-900">No slots on this date</p>
          <p className="mt-2 text-sm text-slate-600">The weekly template produced no windows, or they are outside the booking horizon.</p>
        </div>
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
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader className="gap-3 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-xl text-slate-950">{slot.doctorName}</CardTitle>
            <CardDescription className="mt-1">
              {formatSlotDate(slot.slotDate)} · {formatTimeRange(slot.startTime, slot.endTime)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {slot.isDisabled && <Badge variant="destructive">Disabled</Badge>}
            <Badge variant={slot.bookedCount >= slot.maxPatients ? "secondary" : "outline"} className="gap-1">
              <Users className="size-3" aria-hidden="true" /> {seats} seats
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {slot.appointments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-6 text-center text-sm text-slate-500">
            No bookings in this window.
          </div>
        ) : (
          <ol className="space-y-3">
            {slot.appointments.map((appointment, index) => (
              <li key={appointment.id}>
                {index > 0 && <Separator className="mb-3" />}
                <div className="flex flex-col gap-4 rounded-2xl bg-slate-50/50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-950">{appointment.patient.fullName}</span>
                      <AppointmentStatusBadge status={appointment.status} />
                      {appointment.patient.isProvisional && <Badge variant="outline">Walk-in</Badge>}
                    </div>
                    <p className="text-sm text-slate-600">
                      {appointment.patient.phone}
                      {appointment.patient.email !== null ? ` · ${appointment.patient.email}` : ""}
                    </p>
                    <p className="text-sm text-slate-700">
                      Fee {formatPaise(appointment.feeAmount, "INR")} ·{" "}
                      {appointment.payment.status === "PENDING" ? (
                        <span className="font-medium text-destructive">
                          {formatPaise(appointment.payment.outstandingPaise, "INR")} outstanding
                        </span>
                      ) : appointment.payment.status === "PAID" ? (
                        <span className="text-slate-700">
                          {formatPaise(appointment.payment.paidPaise, "INR")} paid
                          {appointment.payment.method !== null ? ` (${appointment.payment.method})` : ""}
                        </span>
                      ) : (
                        <span className="text-slate-500">Nothing to collect</span>
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
