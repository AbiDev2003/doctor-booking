import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiAdminNotifications, ApiError } from "@/lib/api"
import type { AdminNotification } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export default function Notifications() {
  const [status, setStatus] = useState<AdminNotification["status"] | "">("")
  const [type, setType] = useState("")

  const notifications = useQuery({
    queryKey: ["admin", "notifications", status, type],
    queryFn: ({ signal }) =>
      apiAdminNotifications(
        { ...(status !== "" && { status }), ...(type !== "" && { type }), limit: 100 },
        signal,
      ),
  })

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Notifications</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Notification delivery</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          What the clinic tried to send, and what failed. Delivery is fire-and-forget; failures do not roll back bookings.
        </p>
      </section>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Delivery feed</CardTitle>
          <CardDescription>Filter by delivery status or notification type.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
            <div className="space-y-2">
              <Label htmlFor="notification-status">Status</Label>
              <select
                id="notification-status"
                className={SELECT_CLASS}
                value={status}
                onChange={(event) => setStatus(event.target.value as AdminNotification["status"] | "")}
              >
                <option value="">All statuses</option>
                <option value="PENDING">Pending</option>
                <option value="SENT">Sent</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notification-type">Type</Label>
              <Input
                id="notification-type"
                className="bg-white"
                placeholder="e.g. BOOKING_CONFIRMED"
                value={type}
                onChange={(event) => setType(event.target.value)}
              />
            </div>
          </div>

          {notifications.isPending && <PageLoading label="Loading notifications…" />}
          {notifications.isError && (
            <PageError
              title="Notifications could not be loaded"
              message={notifications.error instanceof ApiError ? notifications.error.message : undefined}
              onRetry={() => void notifications.refetch()}
            />
          )}
          {notifications.data?.notifications.length === 0 && (
            <EmptyState title="No notifications match" description="Try another status or type." />
          )}
          {notifications.data !== undefined && notifications.data.notifications.length > 0 && (
            <ul className="space-y-3">
              {notifications.data.notifications.map((notification) => (
                <li key={notification.id} className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-950">{notification.type}</span>
                        <Badge
                          variant={
                            notification.status === "FAILED"
                              ? "destructive"
                              : notification.status === "SENT"
                                ? "default"
                                : "outline"
                          }
                        >
                          {notification.status.toLowerCase()}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600">To {notification.recipient}</p>
                      {notification.error !== null && <p className="text-sm text-destructive">{notification.error}</p>}
                      <p className="text-xs text-slate-500">
                        Created {formatSlotDate(notification.createdAt.slice(0, 10))}
                        {notification.sentAt === null ? "" : ` · sent ${formatSlotDate(notification.sentAt.slice(0, 10))}`}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
