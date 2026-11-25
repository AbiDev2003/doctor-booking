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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

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
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Appointments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Walk-in and phone bookings</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Find or create a patient by phone, then book an available slot. New numbers create a provisional record that needs no login.
        </p>
      </section>

      {notice !== null && (
        <Alert className="rounded-2xl border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
          <UserPlus className="size-4" />
          <AlertTitle>Booking created</AlertTitle>
          <AlertDescription>
            <p>{notice}</p>
            {booked !== null && (
              <p className="mt-1">
                {booked.patient.fullName} · {booked.appointment.doctorName} · {formatSlotDate(booked.appointment.slotDate)} · {formatTimeRange(booked.appointment.startTime, booked.appointment.endTime)}.
              </p>
            )}
            {booked !== null && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={`/staff/payments?phone=${encodeURIComponent(booked.patient.phone)}`}>
                    <ReceiptText className="size-4" aria-hidden="true" /> Collect payment
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline" className="bg-white">
                  <Link to={`/staff/patients?phone=${encodeURIComponent(booked.patient.phone)}`}>
                    <UserPlus className="size-4" aria-hidden="true" /> Patient record
                  </Link>
                </Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <form
        onSubmit={handleSubmit((values) => {
          setNotice(null)
          setBooked(null)
          setFormError(null)
          create.mutate(values)
        })}
        className="space-y-6"
        noValidate
      >
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Patient details</CardTitle>
            <CardDescription>Use the patient’s phone number to find or create their record.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Field label="Full name" htmlFor="patient-name" error={errors.patient?.fullName?.message}>
              <Input id="patient-name" className="bg-white" autoComplete="off" maxLength={200} aria-invalid={errors.patient?.fullName !== undefined} {...register("patient.fullName")} />
            </Field>
            <Field label="Phone" htmlFor="patient-phone" error={errors.patient?.phone?.message}>
              <Input id="patient-phone" className="bg-white" autoComplete="off" inputMode="tel" placeholder="98765 43210" aria-invalid={errors.patient?.phone !== undefined} {...register("patient.phone")} />
            </Field>
            <Field label="Email (optional)" htmlFor="patient-email" error={errors.patient?.email?.message}>
              <Input
                id="patient-email"
                type="email"
                className="bg-white"
                autoComplete="off"
                aria-invalid={errors.patient?.email !== undefined}
                {...register("patient.email", { setValueAs: (value: string) => (value.trim() === "" ? undefined : value) })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Appointment slot</CardTitle>
            <CardDescription>Select a doctor, date, and available time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
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
                  className="bg-white"
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

            {availability.isPending && <p className="text-sm text-slate-500">Loading slots…</p>}
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
              <p className="text-sm text-destructive" role="alert">{errors.slotId.message}</p>
            )}

            {slots.length > 0 && (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-slate-900">Available times</legend>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {slots.map((slot) => (
                    <label
                      key={slot.slotId}
                      className={
                        slotId === slot.slotId
                          ? "flex cursor-pointer items-center justify-between rounded-2xl border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm ring-1 ring-blue-100"
                          : "flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm hover:bg-slate-50"
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
                        <span className="font-medium text-slate-900">{formatTimeRange(slot.startTime, slot.endTime)}</span>
                      </span>
                      <span className="text-xs text-slate-500">{slot.remaining} left</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </CardContent>
        </Card>

        {formError !== null && (
          <Alert variant="destructive" className="rounded-2xl">
            <AlertTitle>Could not create the booking</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <p className="text-sm text-slate-600">
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

function Field({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}
