import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Banknote, HandCoins, Search } from "lucide-react"
import { apiCompleteHandBack, apiDeskHandBacks, apiVisitHistory, ApiError } from "@/lib/api"
import type { DeskHandBack, VisitHistory } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { OutstandingPanel } from "@/components/payments/outstanding-panel"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const HAND_BACK_LABELS: Record<DeskHandBack["kind"], string> = {
  RESCHEDULE_DELTA: "Reschedule delta",
  CANCELLATION: "Cancellation refund",
  CLINIC_CAUSED: "Clinic-caused refund",
  EXPIRED_HOLD: "Expired hold refund",
  CONVERSION_FAILED: "Conversion failed refund",
  DESK_HAND_BACK: "Desk hand-back",
}

export default function Payments() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<"refunds" | "outstanding">("refunds")
  const [handBack, setHandBack] = useState<DeskHandBack | null>(null)

  const handBacks = useQuery({
    queryKey: ["staff", "hand-backs"],
    queryFn: () => apiDeskHandBacks().then((result) => result.handBacks),
  })

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Payments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Payments and refunds</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Record money that physically changed hands. Online gateway refunds stay with the gateway.
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button variant={tab === "refunds" ? "default" : "outline"} className={tab === "refunds" ? "" : "bg-white"} onClick={() => setTab("refunds")}>
          Refunds
        </Button>
        <Button variant={tab === "outstanding" ? "default" : "outline"} className={tab === "outstanding" ? "" : "bg-white"} onClick={() => setTab("outstanding")}>
          Outstanding
        </Button>
      </div>

      {tab === "refunds" && (
        <div className="space-y-6">
          <Card className="rounded-3xl border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl text-slate-950">
                <HandCoins className="size-5 text-primary" aria-hidden="true" /> Desk hand-backs due
              </CardTitle>
              <CardDescription>Refunds that need to be physically returned at the desk.</CardDescription>
            </CardHeader>
            <CardContent>
              {handBacks.isPending && <PageLoading label="Loading hand-backs…" />}
              {handBacks.isError && (
                <PageError
                  title="Hand-backs could not be loaded"
                  message={handBacks.error instanceof ApiError ? handBacks.error.message : undefined}
                  onRetry={() => void handBacks.refetch()}
                />
              )}
              {handBacks.data !== undefined && handBacks.data.length === 0 && (
                <EmptyState
                  title="Nothing owed at the desk"
                  description="Cancellation and reschedule refunds wait here when the gateway cannot return the money itself."
                >
                  <Banknote className="size-4" />
                </EmptyState>
              )}
              {handBacks.data !== undefined && handBacks.data.length > 0 && (
                <ul className="space-y-3">
                  {handBacks.data.map((entry) => (
                    <li key={entry.refundId} className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-950">{entry.patientName}</span>
                          <Badge variant="outline">{HAND_BACK_LABELS[entry.kind]}</Badge>
                          <span className="text-sm font-semibold text-slate-900">{formatPaise(entry.amountPaise, "INR")}</span>
                        </div>
                        <p className="text-sm text-slate-600">{entry.reason}</p>
                        <p className="text-xs text-slate-500">Raised {formatSlotDate(entry.createdAt.slice(0, 10))} · patient {entry.patientId}</p>
                      </div>
                      <Button size="sm" onClick={() => setHandBack(entry)}>Record hand-back</Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <OutstandingLookup />
        </div>
      )}

      {tab === "outstanding" && <OutstandingPanel scope="staff" />}

      {handBack !== null && (
        <HandBackDialog
          handBack={handBack}
          onClose={() => setHandBack(null)}
          onDone={() => {
            setHandBack(null)
            void queryClient.invalidateQueries({ queryKey: ["staff"] })
          }}
        />
      )}
    </div>
  )
}

function HandBackDialog({
  handBack,
  onClose,
  onDone,
}: {
  handBack: DeskHandBack
  onClose: () => void
  onDone: () => void
}) {
  const [method, setMethod] = useState<"CASH" | "UPI">("CASH")

  const complete = useMutation({
    mutationFn: () => apiCompleteHandBack(handBack.refundId, method),
    onSuccess: onDone,
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm hand-back</DialogTitle>
          <DialogDescription>
            Record that {formatPaise(handBack.amountPaise, "INR")} was physically returned to {handBack.patientName}. This closes the refund queue entry.
          </DialogDescription>
        </DialogHeader>

        <Alert className="rounded-2xl border-amber-200 bg-amber-50/70 text-amber-950 [&>svg]:text-amber-700">
          <AlertTitle>Only record money already handed over</AlertTitle>
          <AlertDescription>This is an audit record, not a gateway instruction.</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label>Method</Label>
          <div className="flex gap-2">
            <Button type="button" variant={method === "CASH" ? "default" : "outline"} className={method === "CASH" ? "" : "bg-white"} onClick={() => setMethod("CASH")}>Cash</Button>
            <Button type="button" variant={method === "UPI" ? "default" : "outline"} className={method === "UPI" ? "" : "bg-white"} onClick={() => setMethod("UPI")}>UPI</Button>
          </div>
        </div>

        {complete.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not record the hand-back</AlertTitle>
            <AlertDescription>{complete.error instanceof ApiError ? complete.error.message : "Try again."}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>Close</Button>
          <Button onClick={() => complete.mutate()} disabled={complete.isPending}>
            {complete.isPending ? "Recording…" : `Hand back ${method === "CASH" ? "cash" : "via UPI"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OutstandingLookup() {
  const [params] = useSearchParams()
  const initialPhone = params.get("phone") ?? ""
  const [phone, setPhone] = useState(initialPhone)
  const [lookedUpPhone, setLookedUpPhone] = useState<string | null>(null)
  const autoSearched = useRef(false)

  const search = useMutation({
    mutationFn: (value: string) => apiVisitHistory(value).then((result) => result.history),
    onSuccess: (history) => setLookedUpPhone(history.patient?.phone ?? phone.trim()),
  })

  useEffect(() => {
    if (autoSearched.current || initialPhone.trim() === "") return
    autoSearched.current = true
    search.mutate(initialPhone.trim())
  }, [initialPhone, search])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (phone.trim() !== "") search.mutate(phone.trim())
  }

  const history: VisitHistory | undefined = search.data
  const outstanding =
    history?.upcomingAppointments.filter((appointment) => appointment.payment.outstandingPaise > 0) ?? []

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-950">Find an outstanding balance</CardTitle>
        <CardDescription>Look up a patient by phone to collect pending payment.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="payment-phone">Patient phone</Label>
            <Input id="payment-phone" className="bg-white" value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="off" placeholder="98765 43210" />
          </div>
          <Button type="submit" disabled={phone.trim() === "" || search.isPending}>
            <Search className="size-4" aria-hidden="true" />
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </form>

        {search.error !== null && (
          <Alert variant="destructive">
            <AlertTitle>Lookup failed</AlertTitle>
            <AlertDescription>{search.error instanceof ApiError ? search.error.message : "Try again."}</AlertDescription>
          </Alert>
        )}

        {history !== undefined && !history.found && (
          <p className="text-sm text-slate-600">No patient on file for {lookedUpPhone ?? "that number"}.</p>
        )}

        {history !== undefined && history.found && outstanding.length === 0 && (
          <p className="text-sm text-slate-600">{history.patient?.fullName ?? "This patient"} has no outstanding balance on upcoming bookings.</p>
        )}

        {outstanding.length > 0 && (
          <ul className="space-y-3">
            {outstanding.map((appointment) => (
              <li key={appointment.id} className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-950">{appointment.doctorName}</span>
                      <AppointmentStatusBadge status={appointment.status} />
                      <Badge variant="destructive">{formatPaise(appointment.payment.outstandingPaise, "INR")} due</Badge>
                    </div>
                    <p className="text-sm text-slate-600">
                      {formatSlotDate(appointment.slotDate)} · {formatTimeRange(appointment.startTime, appointment.endTime)} · {appointment.patient.fullName}
                    </p>
                  </div>
                  <AppointmentActions
                    appointment={appointment}
                    onChanged={() => {
                      if (lookedUpPhone !== null) search.mutate(lookedUpPhone)
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
