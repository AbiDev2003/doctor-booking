import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import {
  apiMyAppointment,
  apiPublicClinic,
  apiPublicDoctorAvailability,
  apiRescheduleAppointment,
  ApiError,
} from "@/lib/api"
import { addDays, clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { formatPaise } from "@/lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * §14's reschedule (Day 30): the patient may move the SAME booking to another
 * slot of the SAME doctor. The server decides bookability, capacity, the cutoff
 * and any fee delta; this page only picks a target and reports what happened.
 */
export default function Reschedule() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pickedDate, setPickedDate] = useState<string | null>(null)

  const appointment = useQuery({
    queryKey: ["patient", "appointment", id],
    queryFn: () => apiMyAppointment(id).then((result) => result.appointment),
    enabled: id !== "",
  })

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })

  const timezone = clinic.data?.clinic.timezone
  const horizonDays = clinic.data?.clinic.bookingHorizonDays
  const minDate = timezone !== undefined ? clinicToday(timezone) : ""
  const maxDate = minDate !== "" && horizonDays !== undefined ? addDays(minDate, horizonDays) : ""

  const selectedDate = pickedDate ?? appointment.data?.slotDate ?? (minDate !== "" ? minDate : null)

  const availability = useQuery({
    queryKey: ["public", "availability", appointment.data?.doctorId, selectedDate],
    queryFn: () =>
      apiPublicDoctorAvailability(appointment.data?.doctorId as string, selectedDate as string),
    enabled: appointment.data !== undefined && selectedDate !== null,
  })

  const move = useMutation({
    mutationFn: (slotId: string) => apiRescheduleAppointment(id, slotId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["patient"] })
      navigate("/patient/appointments", { state: { notice: "Your appointment was moved." } })
    },
  })

  if (appointment.isPending) return <PageLoading label="Loading appointment…" />

  if (appointment.isError || appointment.data === undefined) {
    return (
      <PageError
        title="Appointment not found"
        message={appointment.error instanceof ApiError ? appointment.error.message : undefined}
        onRetry={() => void appointment.refetch()}
      />
    )
  }

  const current = appointment.data
  const errorMessage = move.error instanceof ApiError ? move.error.message : undefined
  const slots = (availability.data?.availability ?? []).filter((slot) => slot.slotId !== current.slotId)

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link to="/patient/appointments">
            <ArrowLeft /> Back to appointments
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold">Reschedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Move this booking to another slot with <strong>{current.doctorName}</strong>. A cheaper slot refunds the
          difference automatically.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current booking</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>{formatSlotDate(current.slotDate)} · {formatTimeRange(current.startTime, current.endTime)}</p>
          <p>{formatPaise(current.feeAmount, "INR")}</p>
        </CardContent>
      </Card>

      {!current.canReschedule && (
        <Alert variant="destructive">
          <AlertTitle>This booking can no longer be moved</AlertTitle>
          <AlertDescription>
            {current.cancelBlockedReason ?? "Only a confirmed booking before the cutoff can be rescheduled."}
          </AlertDescription>
        </Alert>
      )}

      {current.canReschedule && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Choose a date
              <Input
                type="date"
                className="h-9"
                value={selectedDate ?? ""}
                min={minDate}
                max={maxDate}
                onChange={(event) => setPickedDate(event.target.value)}
              />
            </label>
          </div>

          {availability.isPending && (
            <div className="space-y-2" role="status" aria-label="Loading slots">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}

          {availability.isError && (
            <PageError
              title="Slots could not be loaded"
              message={availability.error instanceof ApiError ? availability.error.message : undefined}
              onRetry={() => void availability.refetch()}
            />
          )}

          {availability.data !== undefined && slots.length === 0 && (
            <EmptyState
              title="No other slots on this date"
              description="Try another day within the clinic's booking window."
            />
          )}

          {slots.length > 0 && (
            <ul className="space-y-2">
              {slots.map((slot) => (
                <li
                  key={slot.slotId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
                >
                  <div className="text-sm">
                    <p className="font-medium">{formatTimeRange(slot.startTime, slot.endTime)}</p>
                    <p className="text-muted-foreground">
                      {slot.remaining} {slot.remaining === 1 ? "seat" : "seats"} left
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={move.isPending}
                    onClick={() => move.mutate(slot.slotId)}
                  >
                    {move.isPending ? "Moving…" : "Move here"}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {errorMessage !== undefined && (
            <Alert variant="destructive">
              <AlertTitle>Could not move the booking</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  )
}
