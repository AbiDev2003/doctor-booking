import { useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, CalendarDays, IndianRupee } from "lucide-react"
import {
  apiCancelAppointment,
  apiCancellationPreview,
  apiMyAppointments,
  ApiError,
} from "@/lib/api"
import type { AppointmentScope, PatientAppointment } from "@/lib/api"
import { formatPaise } from "@/lib/money"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function Appointments() {
  const location = useLocation()
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  )

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Appointments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Your appointments</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          View upcoming and past visits. You can cancel before the clinic cutoff or reschedule with the same doctor when available.
        </p>
      </section>

      {notice !== null && (
        <Alert className="border-blue-100 bg-blue-50/60">
          <CalendarDays />
          <AlertTitle>Update</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="upcoming" onValueChange={() => setNotice(null)} className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="h-11 rounded-xl bg-slate-100 p-1">
            <TabsTrigger value="upcoming" className="rounded-lg px-4">Upcoming</TabsTrigger>
            <TabsTrigger value="past" className="rounded-lg px-4">Past</TabsTrigger>
          </TabsList>
          <Button asChild variant="outline" className="bg-white">
            <Link to="/doctors">Book new appointment</Link>
          </Button>
        </div>

        <TabsContent value="upcoming" className="mt-0">
          <AppointmentList scope="upcoming" onCancel={setCancelId} />
        </TabsContent>
        <TabsContent value="past" className="mt-0">
          <AppointmentList scope="past" onCancel={setCancelId} />
        </TabsContent>
      </Tabs>

      <CancelDialog
        appointmentId={cancelId}
        onClose={() => setCancelId(null)}
        onCancelled={() => {
          setCancelId(null)
          setNotice("Appointment cancelled. Any refund is shown on the Payments tab.")
        }}
      />
    </div>
  )
}

function AppointmentList({
  scope,
  onCancel,
}: {
  scope: AppointmentScope
  onCancel: (id: string) => void
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["patient", "appointments", scope],
    queryFn: () => apiMyAppointments(scope).then((result) => result.appointments),
  })

  if (isPending) return <PageLoading label="Loading appointments…" />
  if (isError) {
    return (
      <PageError
        title="Your appointments could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => void refetch()}
      />
    )
  }

  if (data.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
        <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
          <CalendarDays className="size-6" aria-hidden="true" />
        </div>
        <p className="mt-4 text-lg font-semibold text-slate-900">
          {scope === "upcoming" ? "No upcoming appointments" : "No past appointments yet"}
        </p>
        <p className="mt-2 text-sm text-slate-600">
          {scope === "upcoming"
            ? "Book a consultation with a verified doctor."
            : "Your completed and cancelled visits will appear here."}
        </p>
        {scope === "upcoming" && (
          <Button asChild className="mt-5">
            <Link to="/doctors">Find a doctor</Link>
          </Button>
        )}
      </div>
    )
  }

  return (
    <ul className="space-y-4">
      {data.map((appointment) => (
        <li key={appointment.id}>
          <AppointmentCard appointment={appointment} onCancel={onCancel} />
        </li>
      ))}
    </ul>
  )
}

function AppointmentCard({
  appointment,
  onCancel,
}: {
  appointment: PatientAppointment
  onCancel: (id: string) => void
}) {
  const showActions = appointment.canCancel || appointment.canReschedule

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardContent className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-950">{appointment.doctorName}</h2>
              <AppointmentStatusBadge status={appointment.status} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Meta icon={<CalendarDays className="size-4" />} label="Date" value={formatSlotDate(appointment.slotDate)} />
              <Meta icon={<CalendarClock className="size-4" />} label="Time" value={formatTimeRange(appointment.startTime, appointment.endTime)} />
              <Meta icon={<IndianRupee className="size-4" />} label="Fee" value={formatPaise(appointment.feeAmount, "INR")} />
            </div>

            {appointment.clinicCaused && (
              <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-100">
                The clinic changed this booking — you can cancel any time before it starts.
              </p>
            )}
            {!appointment.canCancel && appointment.cancelBlockedReason !== null && appointment.status === "CONFIRMED" && (
              <p className="mt-4 text-sm text-slate-500">{appointment.cancelBlockedReason}</p>
            )}
          </div>

          {showActions && (
            <div className="flex flex-wrap gap-2 lg:justify-end">
              {appointment.canReschedule && (
                <Button asChild variant="outline" className="bg-white">
                  <Link to={`/patient/appointments/${appointment.id}/reschedule`}>Reschedule</Link>
                </Button>
              )}
              {appointment.canCancel && (
                <Button variant="outline" className="border-red-200 bg-white text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => onCancel(appointment.id)}>
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Meta({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        <span className="text-primary">{icon}</span>
        {label}
      </div>
      <p className="mt-1 text-sm font-medium text-slate-900">{value}</p>
    </div>
  )
}

function CancelDialog({
  appointmentId,
  onClose,
  onCancelled,
}: {
  appointmentId: string | null
  onClose: () => void
  onCancelled: () => void
}) {
  const queryClient = useQueryClient()

  const preview = useQuery({
    queryKey: ["patient", "cancel-preview", appointmentId],
    queryFn: () => apiCancellationPreview(appointmentId as string).then((result) => result.preview),
    enabled: appointmentId !== null,
  })

  const cancel = useMutation({
    mutationFn: (id: string) => apiCancelAppointment(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["patient"] })
      onCancelled()
    },
  })

  const previewError = preview.error instanceof ApiError ? preview.error.message : undefined
  const cancelError = cancel.error instanceof ApiError ? cancel.error.message : undefined
  const canCancel = preview.data?.canCancel === true

  return (
    <Dialog open={appointmentId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel this appointment?</DialogTitle>
          <DialogDescription>This cannot be undone. You can book another slot afterwards.</DialogDescription>
        </DialogHeader>

        {preview.isPending && (
          <div className="space-y-2" role="status" aria-label="Checking cancellation terms">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}

        {preview.isError && (
          <PageError
            title="Could not check the cancellation terms"
            message={previewError}
            onRetry={() => void preview.refetch()}
          />
        )}

        {preview.data !== undefined && (
          <div className="space-y-3 text-sm">
            {!preview.data.canCancel && preview.data.cancelBlockedReason !== null && (
              <Alert variant="destructive">
                <AlertTitle>Cancellation is closed</AlertTitle>
                <AlertDescription>{preview.data.cancelBlockedReason}</AlertDescription>
              </Alert>
            )}

            {preview.data.canCancel && (
              <div className="rounded-2xl bg-slate-50 p-4 text-slate-700">
                {preview.data.refundAmountPaise > 0 ? (
                  <p>
                    You will be refunded{" "}
                    <strong className="text-slate-950">{formatPaise(preview.data.refundAmountPaise, "INR")}</strong>
                    {preview.data.refundSettlement === "desk"
                      ? " at the clinic desk (cash or UPI)."
                      : " automatically to your original payment method."}
                  </p>
                ) : preview.data.payment?.status === "PENDING" ? (
                  <p>The unpaid clinic fee for this booking will be cancelled — you owe nothing.</p>
                ) : (
                  <p>This booking has no refundable payment.</p>
                )}
              </div>
            )}

            {cancelError !== undefined && <p className="text-destructive">{cancelError}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={cancel.isPending}>
            Keep appointment
          </Button>
          <Button
            variant="destructive"
            disabled={!canCancel || cancel.isPending}
            onClick={() => appointmentId !== null && cancel.mutate(appointmentId)}
          >
            {cancel.isPending ? "Cancelling…" : "Cancel appointment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
