import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, CalendarDays, Clock, CreditCard, Stethoscope } from "lucide-react"
import { apiMyAppointments, ApiError } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

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
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-white via-white to-blue-50/70 p-6 shadow-sm sm:p-8">
        <div className="absolute -right-10 -top-10 size-40 rounded-full bg-blue-100/50 blur-2xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Patient dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Welcome back
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Keep track of your upcoming visits, review past appointments, and manage payments in one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/doctors">
                Find a doctor
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="bg-white">
              <Link to="/patient/appointments">View appointments</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          icon={<CalendarDays className="size-5" />}
          label="Upcoming appointments"
          value={String(upcomingCount)}
          description="Scheduled visits ahead"
        />
        <StatCard
          icon={<Clock className="size-5" />}
          label="Past visits"
          value={String(pastCount)}
          description="Completed or previous records"
        />
        <StatCard
          icon={<CreditCard className="size-5" />}
          label="Next step"
          value={next ? "Ready" : "Book"}
          description={next ? "Your next visit is scheduled" : "Find a doctor to get started"}
          className="sm:col-span-2 xl:col-span-1"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-xl text-slate-950">Next appointment</CardTitle>
                <CardDescription>Your closest upcoming booking.</CardDescription>
              </div>
              {next && <AppointmentStatusBadge status={next.status} />}
            </div>
          </CardHeader>
          <CardContent>
            {next === undefined ? (
              <EmptyState
                title="No upcoming appointment"
                description="When you book a visit, your next appointment details will appear here."
              >
                <Button asChild size="sm">
                  <Link to="/doctors">Find a doctor</Link>
                </Button>
              </EmptyState>
            ) : (
              <div className="space-y-5">
                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-medium text-slate-500">Doctor</p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">{next.doctorName}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Detail label="Date" value={formatSlotDate(next.slotDate)} />
                    <Detail label="Time" value={formatTimeRange(next.startTime, next.endTime)} />
                    <Detail label="Fee" value={formatPaise(next.feeAmount, "INR")} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button asChild>
                    <Link to="/patient/appointments">
                      Manage appointments
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline" className="bg-white">
                    <Link to={`/patient/appointments`}>View details</Link>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Quick actions</CardTitle>
            <CardDescription>Common things you can do.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QuickLink
              to="/doctors"
              icon={<Stethoscope className="size-4" />}
              title="Find a doctor"
              description="Browse doctors and book a new visit."
            />
            <QuickLink
              to="/patient/appointments"
              icon={<CalendarDays className="size-4" />}
              title="Appointments"
              description="Review, cancel, or reschedule bookings."
            />
            <QuickLink
              to="/patient/payments"
              icon={<CreditCard className="size-4" />}
              title="Payments"
              description="Check fees, payment status, and refunds."
            />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  description,
  className = "",
}: {
  icon: ReactNode
  label: string
  value: string
  description: string
  className?: string
}) {
  return (
    <Card className={["rounded-3xl border-slate-200 shadow-sm", className].join(" ")}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
            <p className="mt-2 text-sm text-slate-600">{description}</p>
          </div>
          <div className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-primary ring-1 ring-blue-100">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-900">{value}</p>
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
      className="group flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-blue-100 hover:bg-blue-50/30 hover:shadow-sm"
    >
      <div className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-primary ring-1 ring-blue-100">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-slate-900">{title}</p>
          <ArrowRight className="size-4 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden="true" />
        </div>
        <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
      </div>
    </Link>
  )
}
