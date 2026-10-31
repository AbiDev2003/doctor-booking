import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, CreditCard, Stethoscope } from "lucide-react"
import { apiMyAppointments, ApiError } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * §27's dashboard overview (Day 30): one honest summary — the next visit, how
 * many are booked, and where to go next. It reuses the same list queries the
 * Appointments tab uses, so the two cannot show different counts.
 */
export default function PatientOverview() {
  const upcoming = useQuery({
    queryKey: ["patient", "appointments", "upcoming"],
    queryFn: () => apiMyAppointments("upcoming").then((result) => result.appointments),
  })
  const past = useQuery({
    queryKey: ["patient", "appointments", "past"],
    queryFn: () => apiMyAppointments("past").then((result) => result.appointments),
  })

  if (upcoming.isPending || past.isPending) return <PageLoading label="Loading your dashboard…" />

  if (upcoming.isError || past.isError) {
    const error = upcoming.error ?? past.error
    return (
      <PageError
        title="Your dashboard could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => {
          void upcoming.refetch()
          void past.refetch()
        }}
      />
    )
  }

  const next = upcoming.data[0]
  const upcomingCount = upcoming.data.length
  const pastCount = past.data.length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Bookings, payments and account — all in one place.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Upcoming appointments</CardDescription>
            <CardTitle className="text-3xl">{upcomingCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Past visits</CardDescription>
            <CardTitle className="text-3xl">{pastCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Next appointment</CardTitle>
          <CardDescription>Your closest confirmed booking.</CardDescription>
        </CardHeader>
        <CardContent>
          {next === undefined ? (
            <EmptyState
              title="Nothing booked yet"
              description="Find a verified doctor and pick a slot that works for you."
            >
              <Button asChild size="sm">
                <Link to="/doctors">Find a doctor</Link>
              </Button>
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{next.doctorName}</p>
                  <AppointmentStatusBadge status={next.status} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatSlotDate(next.slotDate)} · {formatTimeRange(next.startTime, next.endTime)}
                </p>
                <p className="text-sm">{formatPaise(next.feeAmount, "INR")}</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link to="/patient/appointments">View appointments</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <QuickLink to="/doctors" icon={<Stethoscope className="size-4" />} title="Find a doctor" description="Browse specializations and book." />
        <QuickLink to="/patient/appointments" icon={<CalendarDays className="size-4" />} title="Appointments" description="Cancel or reschedule a visit." />
        <QuickLink to="/patient/payments" icon={<CreditCard className="size-4" />} title="Payments" description="Fees paid and refunds." />
      </div>
    </div>
  )
}

function QuickLink({
  to,
  icon,
  title,
  description,
}: {
  to: string
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <Link
      to={to}
      className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-2 font-medium">
        {icon}
        {title}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </Link>
  )
}
