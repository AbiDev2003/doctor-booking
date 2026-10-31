import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiAdminNotifications, ApiError } from "@/lib/api"
import type { AdminNotification } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

/** §29's notification delivery feed (Day 33): failures are first-class. */
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What the clinic tried to send, and what failed. Delivery is fire-and-forget; failures do not roll back bookings.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Delivery feed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Status</span>
              <select
                className={SELECT_CLASS}
                value={status}
                onChange={(event) => setStatus(event.target.value as AdminNotification["status"] | "")}
              >
                <option value="">All statuses</option>
                <option value="PENDING">Pending</option>
                <option value="SENT">Sent</option>
                <option value="FAILED">Failed</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Type</span>
              <input
                className={SELECT_CLASS}
                placeholder="e.g. BOOKING_CONFIRMED"
                value={type}
                onChange={(event) => setType(event.target.value)}
              />
            </label>
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
            <ul className="divide-y">
              {notifications.data.notifications.map((notification) => (
                <li key={notification.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{notification.type}</span>
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
                    <p className="text-sm text-muted-foreground">To {notification.recipient}</p>
                    {notification.error !== null && (
                      <p className="text-sm text-destructive">{notification.error}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Created {formatSlotDate(notification.createdAt.slice(0, 10))}
                      {notification.sentAt === null ? "" : ` · sent ${formatSlotDate(notification.sentAt.slice(0, 10))}`}
                    </p>
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
