import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiAdminPayments, apiAdminRefunds, apiRetryRefund, ApiError } from "@/lib/api"
import type { AdminPayment } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

type Tab = "payments" | "refunds"

/** §29's money ledger (Day 33): every payment, every refund, retry visible. */
export default function Payments() {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>(searchParams.get("tab") === "refunds" ? "refunds" : "payments")
  const [paymentStatus, setPaymentStatus] = useState<AdminPayment["status"] | "">("")
  const [refundStatus, setRefundStatus] = useState<"PENDING" | "SUCCESS" | "FAILED">("FAILED")

  const payments = useQuery({
    queryKey: ["admin", "payments", paymentStatus],
    queryFn: ({ signal }) => apiAdminPayments({ ...(paymentStatus !== "" && { status: paymentStatus }), limit: 100 }, signal),
    enabled: tab === "payments",
  })
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every payment and refund. Retry failed gateway refunds here; cash hand-backs stay at the desk.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={tab === "payments" ? "default" : "outline"} size="sm" onClick={() => setTab("payments")}>
          Payments
        </Button>
        <Button variant={tab === "refunds" ? "default" : "outline"} size="sm" onClick={() => setTab("refunds")}>
          Refunds
        </Button>
      </div>

      {tab === "payments" && (
        <Card>
          <CardHeader>
            <CardTitle>Payment ledger</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block max-w-xs space-y-1 text-sm">
              <span className="text-muted-foreground">Status</span>
              <select
                className={SELECT_CLASS}
                value={paymentStatus}
                onChange={(event) => setPaymentStatus(event.target.value as AdminPayment["status"] | "")}
              >
                <option value="">All statuses</option>
                <option value="PENDING">Pending</option>
                <option value="PAID">Paid</option>
                <option value="FAILED">Failed</option>
                <option value="VOIDED">Voided</option>
              </select>
            </label>

            {payments.isPending && <PageLoading label="Loading payments…" />}
            {payments.isError && (
              <PageError
                title="Payments could not be loaded"
                message={payments.error instanceof ApiError ? payments.error.message : undefined}
                onRetry={() => void payments.refetch()}
              />
            )}
            {payments.data?.payments.length === 0 && <EmptyState title="No payments match" />}
            {payments.data !== undefined && payments.data.payments.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Patient</th>
                      <th className="py-2 pr-3 font-medium">Booking</th>
                      <th className="py-2 pr-3 font-medium">Amount</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 font-medium">Refunds</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {payments.data.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="py-3 pr-3">
                          <p className="font-medium">{payment.patientName}</p>
                          <p className="text-xs text-muted-foreground">{payment.patientPhone}</p>
                        </td>
                        <td className="py-3 pr-3">
                          <p>{payment.doctorName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {payment.slotDate === null
                              ? "No slot"
                              : `${formatSlotDate(payment.slotDate)}${
                                  payment.startTime !== null && payment.endTime !== null
                                    ? ` · ${formatTimeRange(payment.startTime, payment.endTime)}`
                                    : ""
                                }`}
                          </p>
                        </td>
                        <td className="py-3 pr-3">{formatPaise(payment.amountPaise, payment.currency)}</td>
                        <td className="py-3 pr-3">
                          <Badge variant={payment.status === "PAID" ? "default" : "outline"}>
                            {payment.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td className="py-3 text-xs text-muted-foreground">
                          {payment.refunds.length === 0
                            ? "—"
                            : payment.refunds
                                .map((refund) => `${refund.status.toLowerCase()} ${formatPaise(refund.amountPaise, payment.currency)}`)
                                .join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "refunds" && (
        <RefundsPanel status={refundStatus} onStatusChange={setRefundStatus} />
      )}
    </div>
  )
}

function RefundsPanel({
  status,
  onStatusChange,
}: {
  status: "PENDING" | "SUCCESS" | "FAILED"
  onStatusChange: (status: "PENDING" | "SUCCESS" | "FAILED") => void
}) {
  const queryClient = useQueryClient()
  const refunds = useQuery({
    queryKey: ["admin", "refunds", status],
    queryFn: ({ signal }) => apiAdminRefunds({ status, limit: 100 }, signal),
  })
  const retry = useMutation({
    mutationFn: (id: string) => apiRetryRefund(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "refunds"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] })
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refund queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block max-w-xs space-y-1 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select
            className={SELECT_CLASS}
            value={status}
            onChange={(event) => onStatusChange(event.target.value as "PENDING" | "SUCCESS" | "FAILED")}
          >
            <option value="FAILED">Failed</option>
            <option value="PENDING">Pending</option>
            <option value="SUCCESS">Succeeded</option>
          </select>
        </label>

        {retry.error instanceof ApiError && (
          <Alert variant="destructive">
            <AlertTitle>Retry failed</AlertTitle>
            <AlertDescription>{retry.error.message}</AlertDescription>
          </Alert>
        )}
        {retry.data !== undefined && (
          <Alert>
            <AlertTitle>Refund retried</AlertTitle>
            <AlertDescription>{retry.data.message}</AlertDescription>
          </Alert>
        )}

        {refunds.isPending && <PageLoading label="Loading refunds…" />}
        {refunds.isError && (
          <PageError
            title="Refunds could not be loaded"
            message={refunds.error instanceof ApiError ? refunds.error.message : undefined}
            onRetry={() => void refunds.refetch()}
          />
        )}
        {refunds.data?.refunds.length === 0 && (
          <EmptyState title="Nothing in this queue" description="No refunds with this status." />
        )}
        {refunds.data !== undefined && refunds.data.refunds.length > 0 && (
          <ul className="divide-y">
            {refunds.data.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{refund.patientName}</span>
                    <Badge variant={refund.status === "FAILED" ? "destructive" : "outline"}>
                      {refund.status.toLowerCase()}
                    </Badge>
                    <span className="text-sm font-medium">{formatPaise(refund.amountPaise, refund.currency)}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{refund.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {refund.kind.replaceAll("_", " ").toLowerCase()} · raised {formatSlotDate(refund.createdAt.slice(0, 10))}
                    {refund.gatewayRefundId === null ? "" : ` · gateway ${refund.gatewayRefundId}`}
                  </p>
                </div>
                {refund.status === "FAILED" && refund.gatewayRefundId !== null && (
                  <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate(refund.id)}>
                    {retry.isPending ? "Retrying…" : "Retry"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
