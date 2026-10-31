import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { apiAdminOverview, ApiError } from "@/lib/api"
import { formatPaise } from "@/lib/money"
import { PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * §29's admin landing page: today at a glance, plus the two failure queues that
 * need a human (failed gateway refunds, failed notifications).
 */
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
  const appointmentRows = [
    ["Confirmed", data.appointments.confirmed],
    ["Arrived", data.appointments.arrived],
    ["Completed", data.appointments.completed],
    ["Cancelled", data.appointments.cancelled],
    ["Rejected", data.appointments.rejected],
    ["No-show", data.appointments.noShow],
  ] as const

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data.date} · {data.appointments.total} appointment{data.appointments.total === 1 ? "" : "s"} today.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Collected today" value={formatPaise(data.money.collectedPaise, data.currency)} />
        <Stat label="Outstanding today" value={formatPaise(data.money.outstandingPaise, data.currency)} />
        <Stat label="Patients" value={String(data.patients.total)} hint={`${data.patients.provisional} provisional`} />
        <Stat
          label="Doctors"
          value={String(data.doctors.verified)}
          hint={`${data.doctors.pendingVerification} pending · ${data.doctors.suspended} suspended`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Today's appointments</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {appointmentRows.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2 border-b py-1 last:border-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <QueueRow to="/admin/payments" label="Failed gateway refunds" count={data.refunds.failed} />
            <QueueRow to="/admin/payments?tab=refunds" label="Pending refunds" count={data.refunds.pending} />
            <QueueRow to="/admin/notifications" label="Failed notifications" count={data.notifications.failed} />
            <QueueRow to="/admin/notifications" label="Pending notifications" count={data.notifications.pending} />
            <QueueRow to="/admin/doctors" label="Doctors awaiting verification" count={data.doctors.pendingVerification} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
        {hint !== undefined && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

function QueueRow({ to, label, count }: { to: string; label: string; count: number }) {
  return (
    <Link to={to} className="flex items-center justify-between gap-3 rounded-md px-1 py-1 hover:bg-muted">
      <span>{label}</span>
      <Badge variant={count > 0 ? "destructive" : "outline"}>{count}</Badge>
    </Link>
  )
}
