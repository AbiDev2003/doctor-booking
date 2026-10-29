import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { apiMyPayments, ApiError } from "@/lib/api"
import type { PatientPayment, PatientRefund } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

/**
 * §27's payment information (Day 30) — read-only. It shows what the patient was
 * charged, how it was settled, and every refund attached to it (§17). Actions
 * like paying or retrying a failed refund are deliberately not here: paying is
 * part of the booking flow, and retries are an admin decision.
 */

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">Consultation fees and refunds for your bookings.</p>
      </div>

      {data.length === 0 ? (
        <EmptyState title="No payments yet" description="Fees appear here once a booking is made.">
          <Button asChild size="sm">
            <Link to="/doctors">Find a doctor</Link>
          </Button>
        </EmptyState>
      ) : (
        <ul className="space-y-3">
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

function PaymentCard({ payment }: { payment: PatientPayment }) {
  const status = PAYMENT_STATUS[payment.status]

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{formatPaise(payment.amountPaise, payment.currency)}</p>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {payment.doctorName ?? "Consultation"}
              {payment.slotDate !== null && payment.startTime !== null && payment.endTime !== null && (
                <>
                  {" · "}
                  {formatSlotDate(payment.slotDate)} · {formatTimeRange(payment.startTime, payment.endTime)}
                </>
              )}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            {payment.method !== null ? METHOD[payment.method] : "Online"}
          </p>
        </div>

        {payment.refunds.length > 0 && (
          <>
            <Separator />
            <ul className="space-y-2">
              {payment.refunds.map((refund) => (
                <li key={refund.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <p className="font-medium">{REFUND_KIND[refund.kind] ?? refund.kind}</p>
                    <p className="text-muted-foreground">{refund.reason}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span>{formatPaise(refund.amountPaise, payment.currency)}</span>
                    <Badge variant={REFUND_STATUS[refund.status].variant}>
                      {REFUND_STATUS[refund.status].label}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}
