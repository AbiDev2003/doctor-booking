import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays } from "lucide-react"
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
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
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

/**
 * §27's appointment list (Day 30): upcoming and past, with the two actions a
 * patient may take — cancel and reschedule. Which action is open is decided by
 * the server (`canCancel`/`canReschedule`) from the same rules the cancel and
 * reschedule services enforce, so the buttons and the transaction cannot
 * disagree about the §8.5 cutoff or the §12 waiver.
 */
export default function Appointments() {
  const location = useLocation()
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your appointments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cancel before the clinic cutoff for a full refund. Rescheduling keeps the same doctor.
        </p>
      </div>

      {notice !== null && (
        <Alert>
          <CalendarDays />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="upcoming" onValueChange={() => setNotice(null)}>
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
        </TabsList>
        <TabsContent value="upcoming" className="mt-4">
          <AppointmentList scope="upcoming" onCancel={setCancelId} />
        </TabsContent>
        <TabsContent value="past" className="mt-4">
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
      <EmptyState
        title={scope === "upcoming" ? "No upcoming appointments" : "No past appointments yet"}
        description={
          scope === "upcoming"
            ? "Book a consultation with a verified doctor."
            : "Your completed and cancelled visits will appear here."
        }
      >
        {scope === "upcoming" && (
          <Button asChild size="sm">
            <Link to="/doctors">Find a doctor</Link>
          </Button>
        )}
      </EmptyState>
    )
  }

  return (
    <ul className="space-y-3">
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
    <Card>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{appointment.doctorName}</h2>
            <AppointmentStatusBadge status={appointment.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatSlotDate(appointment.slotDate)} · {formatTimeRange(appointment.startTime, appointment.endTime)}
          </p>
          <p className="text-sm">{formatPaise(appointment.feeAmount, "INR")}</p>
          {appointment.clinicCaused && (
            <p className="text-sm text-muted-foreground">
              The clinic changed this booking — you can cancel any time before it starts.
            </p>
          )}
          {!appointment.canCancel && appointment.cancelBlockedReason !== null && appointment.status === "CONFIRMED" && (
            <p className="text-sm text-muted-foreground">{appointment.cancelBlockedReason}</p>
          )}
        </div>

        {showActions && (
          <>
            <Separator className="sm:hidden" />
            <div className="flex flex-wrap gap-2">
              {appointment.canReschedule && (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/patient/appointments/${appointment.id}/reschedule`}>Reschedule</Link>
                </Button>
              )}
              {appointment.canCancel && (
                <Button variant="outline" size="sm" onClick={() => onCancel(appointment.id)}>
                  Cancel
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
      <DialogContent>
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
          <div className="space-y-2 text-sm">
            {!preview.data.canCancel && preview.data.cancelBlockedReason !== null && (
              <Alert variant="destructive">
                <AlertTitle>Cancellation is closed</AlertTitle>
                <AlertDescription>{preview.data.cancelBlockedReason}</AlertDescription>
              </Alert>
            )}

            {preview.data.canCancel && (
              <>
                {preview.data.refundAmountPaise > 0 ? (
                  <p>
                    You will be refunded{" "}
                    <strong>{formatPaise(preview.data.refundAmountPaise, "INR")}</strong>
                    {preview.data.refundSettlement === "desk"
                      ? " at the clinic desk (cash or UPI)."
                      : " automatically to your original payment method."}
                  </p>
                ) : preview.data.payment?.status === "PENDING" ? (
                  <p>The unpaid clinic fee for this booking will be cancelled — you owe nothing.</p>
                ) : (
                  <p>This booking has no refundable payment.</p>
                )}
              </>
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
