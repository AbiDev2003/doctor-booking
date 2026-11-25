import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiAdminPayments, apiAdminRefunds, apiRetryRefund, ApiError } from "@/lib/api"
import type { AdminPayment } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { OutstandingPanel } from "@/components/payments/outstanding-panel"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

type Tab = "payments" | "refunds" | "outstanding"

export default function Payments() {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>(() => {
    const requested = searchParams.get("tab")
    return requested === "refunds" || requested === "outstanding" ? requested : "payments"
  })

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Payments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Payments and refunds</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Every payment and refund. Retry failed gateway refunds here; cash hand-backs stay at the desk.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {(["payments", "refunds", "outstanding"] as const).map((value) => (
            <Button
              key={value}
              variant={tab === value ? "default" : "outline"}
              className={tab === value ? "" : "bg-white"}
              onClick={() => setTab(value)}
            >
              {value === "payments" ? "Payments" : value === "refunds" ? "Refunds" : "Outstanding"}
            </Button>
          ))}
        </div>
      </section>

      {tab === "payments" && <PaymentsTab />}
      {tab === "refunds" && <RefundsTab />}
      {tab === "outstanding" && <OutstandingPanel scope="admin" />}
    </div>
  )
}

function PaymentsTab() {
  const [paymentStatus, setPaymentStatus] = useState<AdminPayment["status"] | "">("")
  const [method, setMethod] = useState<"CASH" | "CARD" | "UPI" | "">("")

  const payments = useQuery({
    queryKey: ["admin", "payments", paymentStatus, method],
    queryFn: ({ signal }) =>
      apiAdminPayments(
        {
          ...(paymentStatus !== "" && { status: paymentStatus }),
          ...(method !== "" && { method }),
          limit: 100,
        },
        signal,
      ),
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-950">Payment ledger</CardTitle>
        <CardDescription>Filter clinic payment records by status and method.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="payment-status">Status</Label>
            <select
              id="payment-status"
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment-method">Method</Label>
            <select
              id="payment-method"
              className={SELECT_CLASS}
              value={method}
              onChange={(event) => setMethod(event.target.value as "CASH" | "CARD" | "UPI" | "")}
            >
              <option value="">All methods</option>
              <option value="CASH">Cash</option>
              <option value="CARD">Card</option>
              <option value="UPI">UPI</option>
            </select>
          </div>
        </div>

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
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th scope="col" className="py-3 pr-3 font-medium">Patient</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Booking</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Amount</th>
                  <th scope="col" className="py-3 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-3 font-medium">Refunds</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.data.payments.map((payment) => (
                  <tr key={payment.id} className="align-top">
                    <td className="py-3 pr-3">
                      <p className="font-medium text-slate-900">{payment.patientName}</p>
                      <p className="text-xs text-slate-500">{payment.patientPhone}</p>
                    </td>
                    <td className="py-3 pr-3 text-slate-600">
                      <p>{payment.doctorName ?? "—"}</p>
                      <p className="text-xs text-slate-500">
                        {payment.slotDate === null
                          ? "No slot"
                          : `${formatSlotDate(payment.slotDate)}${
                              payment.startTime !== null && payment.endTime !== null
                                ? ` · ${formatTimeRange(payment.startTime, payment.endTime)}`
                                : ""
                            }`}
                      </p>
                    </td>
                    <td className="py-3 pr-3 text-slate-900">{formatPaise(payment.amountPaise, payment.currency)}</td>
                    <td className="py-3 pr-3">
                      <Badge variant={payment.status === "PAID" ? "default" : payment.status === "FAILED" ? "destructive" : "outline"}>
                        {payment.status.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="py-3 text-xs text-slate-500">
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
  )
}

function RefundsTab() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<"PENDING" | "SUCCESS" | "FAILED">("FAILED")
  const [notice, setNotice] = useState<string | null>(null)

  const refunds = useQuery({
    queryKey: ["admin", "refunds", status],
    queryFn: ({ signal }) => apiAdminRefunds({ status, limit: 100 }, signal),
  })

  const retry = useMutation({
    mutationFn: (id: string) => apiRetryRefund(id),
    onSuccess: (result) => {
      setNotice(result.message)
      void queryClient.invalidateQueries({ queryKey: ["admin", "refunds"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
    },
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-950">Refund queue</CardTitle>
        <CardDescription>Gateway refunds and their current status. Retry is available for failed gateway refunds.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs space-y-2">
          <Label htmlFor="refund-status">Status</Label>
          <select
            id="refund-status"
            className={SELECT_CLASS}
            value={status}
            onChange={(event) => setStatus(event.target.value as "PENDING" | "SUCCESS" | "FAILED")}
          >
            <option value="FAILED">Failed</option>
            <option value="PENDING">Pending</option>
            <option value="SUCCESS">Succeeded</option>
          </select>
        </div>

        {notice !== null && (
          <Alert className="rounded-2xl border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertTitle>Refund updated</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {retry.error instanceof ApiError && (
          <Alert variant="destructive" className="rounded-2xl">
            <AlertTitle>Retry failed</AlertTitle>
            <AlertDescription>{retry.error.message}</AlertDescription>
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
        {refunds.data?.refunds.length === 0 && <EmptyState title="Nothing in this queue" description="No refunds with this status." />}
        {refunds.data !== undefined && refunds.data.refunds.length > 0 && (
          <ul className="space-y-3">
            {refunds.data.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-950">{refund.patientName}</span>
                    <Badge variant={refund.status === "FAILED" ? "destructive" : refund.status === "SUCCESS" ? "default" : "outline"}>
                      {refund.status.toLowerCase()}
                    </Badge>
                    <span className="text-sm font-medium text-slate-900">{formatPaise(refund.amountPaise, refund.currency)}</span>
                  </div>
                  <p className="text-sm text-slate-600">{refund.reason}</p>
                  <p className="text-xs text-slate-500">
                    {refund.kind.replaceAll("_", " ").toLowerCase()} · raised {formatSlotDate(refund.createdAt.slice(0, 10))}
                    {refund.gatewayRefundId === null ? "" : ` · gateway ${refund.gatewayRefundId}`}
                  </p>
                </div>
                {refund.status === "FAILED" && refund.gatewayRefundId !== null && (
                  <Button
                    size="sm"
                    className="bg-white"
                    variant="outline"
                    disabled={retry.isPending}
                    onClick={() => {
                      setNotice(null)
                      retry.mutate(refund.id)
                    }}
                  >
                    {retry.isPending && retry.variables === refund.id ? "Retrying…" : "Retry"}
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
