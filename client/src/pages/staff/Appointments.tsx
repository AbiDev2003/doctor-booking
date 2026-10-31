import { useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CalendarDays, ReceiptText, UserPlus } from "lucide-react"
import { createDeskBookingSchema } from "@shared/staff"
import {
  apiCreateDeskBooking,
  apiPublicClinic,
  apiPublicDoctorAvailability,
  apiStaffDoctors,
  ApiError,
} from "@/lib/api"
import type { CreateDeskBookingInput, DeskBookingResult } from "@/lib/api"
import { addDays, clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { applyApiErrors } from "@/lib/formErrors"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * §16/§29's desk booking surface (Day 32): create-or-find a provisional
 * patient by phone, then claim a bookable slot.
 *
 * Available slots come from the same public availability read model patients
 * use, so the desk cannot pick a disabled, started or full window from a stale
 * list — and the service re-checks inside the transaction regardless. The
 * patient's name is only captured on a first visit; an existing phone reuses the
 * row the clinic already has.
 */
export default function Appointments() {
  const queryClient = useQueryClient()
  const [doctorId, setDoctorId] = useState("")
  const [date, setDate] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [booked, setBooked] = useState<DeskBookingResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateDeskBookingInput>({
    resolver: zodResolver(createDeskBookingSchema),
    mode: "onChange",
    defaultValues: {
      slotId: "",
      patient: { fullName: "", phone: "", email: "" },
    },
  })
  const slotId = useWatch({ control, name: "slotId" })

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: () => apiStaffDoctors() })

  const timezone = clinic.data?.clinic.timezone
  const horizonDays = clinic.data?.clinic.bookingHorizonDays
  const minDate = timezone === undefined ? "" : clinicToday(timezone)
  const maxDate = minDate !== "" && horizonDays !== undefined ? addDays(minDate, horizonDays) : ""

  const selectedDoctorId =
    doctorId !== "" ? doctorId : (doctors.data?.doctors.find((doctor) => doctor.isBookable)?.id ?? "")
  const selectedDate = date !== "" ? date : minDate

  const availability = useQuery({
    queryKey: ["public", "availability", selectedDoctorId, selectedDate],
    queryFn: () => apiPublicDoctorAvailability(selectedDoctorId, selectedDate),
    enabled: selectedDoctorId !== "" && selectedDate !== "",
  })

  const create = useMutation({
    mutationFn: (values: CreateDeskBookingInput) => apiCreateDeskBooking(values),
    onSuccess: (result) => {
      setBooked(result)
      setNotice(result.message)
      setFormError(null)
      reset({
        slotId: "",
        patient: { fullName: "", phone: "", email: "" },
      })
      void queryClient.invalidateQueries({ queryKey: ["staff"] })
      void queryClient.invalidateQueries({ queryKey: ["admin"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    },
    onError: (error) => {
      setNotice(null)
      setBooked(null)
      setFormError(applyApiErrors(error, setError) ?? null)
    },
  })

  if (clinic.isPending || doctors.isPending) return <PageLoading label="Loading booking options…" />

  if (clinic.isError || doctors.isError) {
    const error = clinic.error ?? doctors.error
    return (
      <PageError
        title="Booking options could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => {
          void clinic.refetch()
          void doctors.refetch()
        }}
      />
    )
  }

  const bookableDoctors = doctors.data.doctors.filter((doctor) => doctor.isBookable)
  const slots = availability.data?.availability ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Walk-in and phone bookings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search the patient by phone when you book. A new number creates a provisional record that needs no login.
        </p>
      </div>

      {notice !== null && (
        <Alert>
          <UserPlus className="size-4" />
          <AlertTitle>Booking created</AlertTitle>
          <AlertDescription>
            {notice}
            {booked !== null && (
              <span>
                {" "}
                {booked.patient.fullName} · {booked.appointment.doctorName} ·{" "}
                {formatSlotDate(booked.appointment.slotDate)} ·{" "}
                {formatTimeRange(booked.appointment.startTime, booked.appointment.endTime)}.
              </span>
            )}
            {booked !== null && (
              <span className="mt-3 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={`/staff/payments?phone=${encodeURIComponent(booked.patient.phone)}`}>
                    <ReceiptText /> Collect payment
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/staff/patients?phone=${encodeURIComponent(booked.patient.phone)}`}>
                    <UserPlus /> Patient record
                  </Link>
                </Button>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit((values) => {
        setNotice(null)
        setBooked(null)
        setFormError(null)
        create.mutate(values)
      })} className="space-y-4" noValidate>
        <Card>
          <CardHeader>
            <CardTitle>Patient</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="patient-name">Full name</Label>
              <Input
                id="patient-name"
                autoComplete="off"
                maxLength={200}
                aria-invalid={errors.patient?.fullName !== undefined}
                aria-describedby={errors.patient?.fullName !== undefined ? "patient-name-error" : undefined}
                {...register("patient.fullName")}
              />
              {errors.patient?.fullName?.message !== undefined && (
                <p id="patient-name-error" className="text-xs text-destructive" role="alert">
                  {errors.patient.fullName.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-phone">Phone</Label>
              <Input
                id="patient-phone"
                autoComplete="off"
                inputMode="tel"
                placeholder="98765 43210"
                aria-invalid={errors.patient?.phone !== undefined}
                aria-describedby={errors.patient?.phone !== undefined ? "patient-phone-error" : undefined}
                {...register("patient.phone")}
              />
              {errors.patient?.phone?.message !== undefined && (
                <p id="patient-phone-error" className="text-xs text-destructive" role="alert">
                  {errors.patient.phone.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-email">Email (optional)</Label>
              <Input
                id="patient-email"
                type="email"
                autoComplete="off"
                aria-invalid={errors.patient?.email !== undefined}
                aria-describedby={errors.patient?.email !== undefined ? "patient-email-error" : undefined}
                {...register("patient.email", {
                  setValueAs: (value: string) => (value.trim() === "" ? undefined : value),
                })}
              />
              {errors.patient?.email?.message !== undefined && (
                <p id="patient-email-error" className="text-xs text-destructive" role="alert">
                  {errors.patient.email.message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Slot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="booking-doctor">Doctor</Label>
                <select
                  id="booking-doctor"
                  className={SELECT_CLASS}
                  value={selectedDoctorId}
                  onChange={(event) => {
                    setDoctorId(event.target.value)
                    setValue("slotId", "", { shouldValidate: true })
                  }}
                >
                  {bookableDoctors.length === 0 && <option value="">No verified doctors available</option>}
                  {bookableDoctors.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.fullName}
                      {doctor.specialization !== null ? ` · ${doctor.specialization}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="booking-date">Date</Label>
                <Input
                  id="booking-date"
                  type="date"
                  value={selectedDate}
                  min={minDate}
                  max={maxDate}
                  onChange={(event) => {
                    setDate(event.target.value)
                    setValue("slotId", "", { shouldValidate: true })
                  }}
                />
              </div>
            </div>

            {availability.isPending && <p className="text-sm text-muted-foreground">Loading slots…</p>}
            {availability.isError && (
              <PageError
                title="Slots could not be loaded"
                message={availability.error instanceof ApiError ? availability.error.message : undefined}
                onRetry={() => void availability.refetch()}
              />
            )}

            {availability.data !== undefined && slots.length === 0 && (
              <EmptyState
                title="No bookable slots"
                description="Try another date or doctor within the clinic's booking window."
              >
                <CalendarDays className="size-4" />
              </EmptyState>
            )}

            {errors.slotId?.message !== undefined && (
              <p className="text-xs text-destructive" role="alert">
                {errors.slotId.message}
              </p>
            )}

            {slots.length > 0 && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Available times</legend>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {slots.map((slot) => (
                    <label
                      key={slot.slotId}
                      className={
                        slotId === slot.slotId
                          ? "flex cursor-pointer items-center justify-between rounded-lg border border-primary bg-accent px-3 py-2 text-sm"
                          : "flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm"
                      }
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="slot"
                          value={slot.slotId}
                          checked={slotId === slot.slotId}
                          onChange={() => setValue("slotId", slot.slotId, { shouldValidate: true })}
                        />
                        {formatTimeRange(slot.startTime, slot.endTime)}
                      </span>
                      <span className="text-xs text-muted-foreground">{slot.remaining} left</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </CardContent>
        </Card>

        {formError !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not create the booking</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {slotId === "" ? "Choose a slot to continue." : "The fee is resolved by the server when the booking is created."}
          </p>
          <Button type="submit" disabled={isSubmitting || create.isPending}>
            {create.isPending ? "Booking…" : "Create booking"}
          </Button>
        </div>
      </form>
    </div>
  )
}
