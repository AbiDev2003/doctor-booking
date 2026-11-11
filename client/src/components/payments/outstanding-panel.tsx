import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, ExternalLink } from "lucide-react"
import {
  apiAdminOutstandingPayments,
  apiCollectOfflinePayment,
  apiOutstandingPayments,
  apiVoidOfflinePayment,
  ApiError,
} from "@/lib/api"
import type { OutstandingPayment } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { ReasonDialog } from "@/components/staff/reason-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

/**
 * Outstanding receivables shared by the admin and staff Payments tabs.
 *
 * One row per unpaid pay-at-clinic payment. The due state is computed server-
 * side against the clinic's day, so "overdue" means the same thing at the desk
 * and in the dashboard. Admin sees the same list read-only and follows the link
 * to the desk; staff can collect or void each row here.
 */
export function OutstandingPanel({ scope }: { scope: "admin" | "staff" }) {
  const actionable = scope === "staff"
  const queryClient = useQueryClient()
  const [collecting, setCollecting] = useState<OutstandingPayment | null>(null)
  const [voiding, setVoiding] = useState<OutstandingPayment | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const outstanding = useQuery({
    queryKey: ["outstanding", scope],
    queryFn: ({ signal }) =>
      actionable
        ? apiOutstandingPayments({ limit: 100 }, signal)
        : apiAdminOutstandingPayments({ limit: 100 }, signal),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["outstanding"] })
    void queryClient.invalidateQueries({ queryKey: ["admin"] })
    void queryClient.invalidateQueries({ queryKey: ["staff"] })
  }

  const voidPayment = useMutation({
    mutationFn: ({ payment, reason }: { payment: OutstandingPayment; reason: string }) =>
      apiVoidOfflinePayment({ appointmentId: payment.appointmentId, reason }),
    onSuccess: (result) => {
      setNotice(result.message)
      setVoiding(null)
      refresh()
    },
  })

  const actionError = voidPayment.error instanceof ApiError ? voidPayment.error.message : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="size-4" /> Outstanding balances
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {actionable
            ? "Unpaid pay-at-clinic money, overdue first. Collect it, or void it with a reason."
            : "Unpaid pay-at-clinic money, overdue first. This view is read-only; collect or void at the front desk."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice !== null && (
          <Alert>
            <AlertTitle>Done</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {actionError !== undefined && (
          <Alert variant="destructive">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {outstanding.isPending && <PageLoading label="Loading outstanding balances…" />}
        {outstanding.isError && (
          <PageError
            title="Outstanding balances could not be loaded"
            message={outstanding.error instanceof ApiError ? outstanding.error.message : undefined}
            onRetry={() => void outstanding.refetch()}
          />
        )}

        {outstanding.data !== undefined && (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Total label="Overdue" value={formatPaise(outstanding.data.totals.overduePaise, "INR")} destructive />
              <Total label="Due today" value={formatPaise(outstanding.data.totals.todayPaise, "INR")} />
              <Total label="Upcoming" value={formatPaise(outstanding.data.totals.upcomingPaise, "INR")} />
              <Total label={`Total (${outstanding.data.totals.count})`} value={formatPaise(outstanding.data.totals.totalPaise, "INR")} />
            </dl>

            {!actionable && (
              <p className="text-sm text-muted-foreground">
                <Link to="/staff/payments" className="inline-flex items-center gap-1 underline underline-offset-4">
                  Open the front desk to collect or void <ExternalLink className="size-3" />
                </Link>
              </p>
            )}

            {outstanding.data.payments.length === 0 && (
              <EmptyState
                title="Nothing outstanding"
                description="Every live booking for this clinic has been settled."
              />
            )}

            {outstanding.data.payments.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-2 pr-3 font-medium">Patient</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Booking</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Amount</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Due</th>
                      {actionable && <th scope="col" className="py-2 font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {outstanding.data.payments.map((payment) => (
                      <tr key={payment.paymentId}>
                        <td className="py-3 pr-3">
                          <p className="font-medium">{payment.patientName}</p>
                          <p className="text-xs text-muted-foreground">{payment.patientPhone}</p>
                        </td>
                        <td className="py-3 pr-3">
                          <p>{payment.doctorName}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatSlotDate(payment.slotDate)} · {formatTimeRange(payment.startTime, payment.endTime)}
                          </p>
                        </td>
                        <td className="py-3 pr-3 font-medium">{formatPaise(payment.amountPaise, payment.currency)}</td>
                        <td className="py-3 pr-3">
                          <DueBadge state={payment.dueState} />
                        </td>
                        {actionable && (
                          <td className="py-3">
                            <div className="flex flex-wrap gap-2">
                              <Button size="sm" onClick={() => setCollecting(payment)}>
                                Collect
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setVoiding(payment)}>
                                Void
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {collecting !== null && (
          <CollectDialog
            payment={collecting}
            onClose={() => setCollecting(null)}
            onDone={(message) => {
              setNotice(message)
              setCollecting(null)
              refresh()
            }}
          />
        )}

        {voiding !== null && (
          <ReasonDialog
            open
            onOpenChange={(open) => {
              if (!open) setVoiding(null)
            }}
            title="Void outstanding payment"
            description={`This writes off ${formatPaise(voiding.amountPaise, voiding.currency)} for ${
              voiding.patientName
            }. The reason is audited.`}
            confirmLabel="Void payment"
            pending={voidPayment.isPending}
            error={actionError}
            onConfirm={(reason) => voidPayment.mutate({ payment: voiding, reason })}
          />
        )}
      </CardContent>
    </Card>
  )
}

function Total({ label, value, destructive = false }: { label: string; value: string; destructive?: boolean }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-lg font-semibold ${destructive ? "text-destructive" : ""}`}>{value}</dd>
    </div>
  )
}

function DueBadge({ state }: { state: OutstandingPayment["dueState"] }) {
  if (state === "OVERDUE") return <Badge variant="destructive">overdue</Badge>
  if (state === "TODAY") return <Badge>due today</Badge>
  return <Badge variant="outline">upcoming</Badge>
}

function CollectDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: OutstandingPayment
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [method, setMethod] = useState<"CASH" | "CARD" | "UPI">("CASH")

  const collect = useMutation({
    mutationFn: () => apiCollectOfflinePayment({ appointmentId: payment.appointmentId, method }),
    onSuccess: (result) => onDone(result.message),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Collect outstanding payment</DialogTitle>
          <DialogDescription>
            Record {formatPaise(payment.amountPaise, payment.currency)} from {payment.patientName} for{" "}
            {payment.doctorName} on {formatSlotDate(payment.slotDate)}.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <AlertTitle>Only record money already received</AlertTitle>
          <AlertDescription>This closes the outstanding balance and writes an audit entry.</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label>Method</Label>
          <div className="flex flex-wrap gap-2">
            {(["CASH", "CARD", "UPI"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                variant={method === option ? "default" : "outline"}
                onClick={() => setMethod(option)}
              >
                {option === "CASH" ? "Cash" : option === "CARD" ? "Card" : "UPI"}
              </Button>
            ))}
          </div>
        </div>

        {collect.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not record the payment</AlertTitle>
            <AlertDescription>
              {collect.error instanceof ApiError ? collect.error.message : "Try again."}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={collect.isPending}>
            Close
          </Button>
          <Button onClick={() => collect.mutate()} disabled={collect.isPending}>
            {collect.isPending ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
