import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { CreditCard, Receipt, RefreshCcw, Wallet } from "lucide-react"
import { apiMyPayments, ApiError } from "@/lib/api"
import type { PatientPayment, PatientRefund } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

const PAYMENT_STATUS: Record<
  PatientPayment["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  PAID: { label: "Paid", variant: "default" },
  PENDING: { label: "Payment due", variant: "secondary" },
  FAILED: { label: "Failed", variant: "destructive" },
  VOIDED: { label: "Voided", variant: "outline" },
}

const REFUND_STATUS: Record<
  PatientRefund["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  SUCCESS: { label: "Refunded", variant: "default" },
  PENDING: { label: "Refund pending", variant: "secondary" },
  FAILED: { label: "Refund failed", variant: "destructive" },
}

const REFUND_KIND: Record<string, string> = {
  RESCHEDULE_DELTA: "Reschedule difference",
  CANCELLATION: "Cancellation",
  CLINIC_CAUSED: "Clinic-caused cancellation",
  EXPIRED_HOLD: "Expired payment hold",
  CONVERSION_FAILED: "Booking could not be completed",
  DESK_HAND_BACK: "Desk hand-back",
}

const METHOD: Record<NonNullable<PatientPayment["method"]>, string> = {
  CASH: "Cash",
  CARD: "Card",
  UPI: "UPI",
}

export default function Payments() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["patient", "payments"],
    queryFn: () => apiMyPayments().then((result) => result.payments),
  })

  if (isPending) return <PageLoading label="Loading payments…" />
  if (isError) {
    return (
      <PageError
        title="Payments could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => void refetch()}
      />
    )
  }

  const totalPaid = data
    .filter((p) => p.status === "PAID")
    .reduce((sum, p) => sum + p.amountPaise, 0)
  const totalPending = data
    .filter((p) => p.status === "PENDING")
    .reduce((sum, p) => sum + p.amountPaise, 0)
  const totalRefunded = data
    .flatMap((p) => p.refunds)
    .filter((r) => r.status === "SUCCESS")
    .reduce((sum, r) => sum + r.amountPaise, 0)

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Payments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Payments & refunds</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Track consultation fees, payment status, and refunds for your bookings.
        </p>
      </section>

      {data.length > 0 && (
        <section className="grid gap-4 sm:grid-cols-3">
          <SummaryCard icon={<Wallet className="size-5" />} label="Paid" value={formatPaise(totalPaid, "INR")} />
          <SummaryCard icon={<CreditCard className="size-5" />} label="Payment due" value={formatPaise(totalPending, "INR")} />
          <SummaryCard icon={<RefreshCcw className="size-5" />} label="Refunded" value={formatPaise(totalRefunded, "INR")} />
        </section>
      )}

      {data.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
            <Receipt className="size-6" aria-hidden="true" />
          </div>
          <p className="mt-4 text-lg font-semibold text-slate-900">No payments yet</p>
          <p className="mt-2 text-sm text-slate-600">Fees appear here once a booking is made.</p>
          <Button asChild className="mt-5">
            <Link to="/doctors">Find a doctor</Link>
          </Button>
        </div>
      ) : (
        <ul className="space-y-4">
          {data.map((payment) => (
            <li key={payment.id}>
              <PaymentCard payment={payment} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardContent className="flex items-center gap-4 p-5">
        <div className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-primary ring-1 ring-blue-100">
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function PaymentCard({ payment }: { payment: PatientPayment }) {
  const status = PAYMENT_STATUS[payment.status]

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xl font-semibold text-slate-950">{formatPaise(payment.amountPaise, payment.currency)}</p>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <p className="text-sm font-medium text-slate-800">{payment.doctorName ?? "Consultation"}</p>
            <p className="text-sm text-slate-500">
              {payment.slotDate !== null && payment.startTime !== null && payment.endTime !== null ? (
                <>
                  {formatSlotDate(payment.slotDate)} · {formatTimeRange(payment.startTime, payment.endTime)}
                </>
              ) : (
                "Appointment details unavailable"
              )}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm sm:text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Method</p>
            <p className="mt-1 font-medium text-slate-900">
              {payment.method !== null ? METHOD[payment.method] : "Online"}
            </p>
          </div>
        </div>

        {payment.refunds.length > 0 && (
          <div className="mt-5 border-t border-slate-100 pt-5">
            <p className="mb-3 text-sm font-semibold text-slate-900">Refunds</p>
            <ul className="space-y-3">
              {payment.refunds.map((refund) => (
                <li key={refund.id} className="flex flex-col gap-2 rounded-2xl bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-slate-900">{REFUND_KIND[refund.kind] ?? refund.kind}</p>
                    {refund.reason && <p className="text-sm text-slate-600">{refund.reason}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{formatPaise(refund.amountPaise, payment.currency)}</span>
                    <Badge variant={REFUND_STATUS[refund.status].variant}>{REFUND_STATUS[refund.status].label}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
