import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { apiAdminOverview, ApiError } from "@/lib/api"
import { formatPaise } from "@/lib/money"
import { PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Overview() {
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: ({ signal }) => apiAdminOverview(signal) })

  if (overview.isPending) return <PageLoading label="Loading overview…" />
  if (overview.isError) {
    return (
      <PageError
        title="Overview could not be loaded"
        message={overview.error instanceof ApiError ? overview.error.message : undefined}
        onRetry={() => void overview.refetch()}
      />
    )
  }

  const data = overview.data.overview
  const statCards = [
    { label: "Collected today", value: formatPaise(data.money.collectedPaise, data.currency) },
    { label: "Outstanding today", value: formatPaise(data.money.outstandingPaise, data.currency) },
    { label: "Patients", value: String(data.patients.total), hint: `${data.patients.provisional} provisional` },
    {
      label: "Verified doctors",
      value: String(data.doctors.verified),
      hint: `${data.doctors.pendingVerification} pending · ${data.doctors.suspended} suspended`,
    },
  ]
  const appointmentRows = [
    ["Confirmed", data.appointments.confirmed],
    ["Arrived", data.appointments.arrived],
    ["Completed", data.appointments.completed],
    ["Cancelled", data.appointments.cancelled],
    ["Rejected", data.appointments.rejected],
    ["No-show", data.appointments.noShow],
  ] as const

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Admin</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Clinic overview</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          {data.date} · {data.appointments.total} appointment{data.appointments.total === 1 ? "" : "s"} today.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((card) => (
          <Card key={card.label} className="rounded-3xl border-slate-200 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-slate-500">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">{card.value}</p>
              {"hint" in card && card.hint && <p className="mt-1 text-xs text-slate-500">{card.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Today&apos;s appointments</CardTitle>
            <CardDescription>Current-day appointment status breakdown.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 sm:grid-cols-2">
              {appointmentRows.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="font-semibold text-slate-950">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Needs attention</CardTitle>
            <CardDescription>Queues that may need admin action.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QueueRow to="/admin/appointments?scope=needsAttention" label="Unclosed past bookings" count={data.appointments.unclosedPast} />
            <QueueRow to="/admin/payments?tab=refunds" label="Failed gateway refunds" count={data.refunds.failed} />
            <QueueRow to="/admin/payments?tab=refunds" label="Pending refunds" count={data.refunds.pending} />
            <QueueRow to="/admin/notifications?status=FAILED" label="Failed notifications" count={data.notifications.failed} />
            <QueueRow to="/admin/notifications" label="Pending notifications" count={data.notifications.pending} />
            <QueueRow to="/admin/doctors" label="Doctors awaiting verification" count={data.doctors.pendingVerification} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function QueueRow({ to, label, count }: { to: string; label: string; count: number }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-sm hover:bg-slate-100/80"
    >
      <span className="font-medium text-slate-900">{label}</span>
      <Badge variant={count > 0 ? "destructive" : "outline"}>{count}</Badge>
    </Link>
  )
}
