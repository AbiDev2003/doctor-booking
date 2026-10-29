import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, UserPlus } from "lucide-react"
import {
  apiCreateDeskBooking,
  apiPublicClinic,
  apiPublicDoctorAvailability,
  apiStaffDoctors,
  ApiError,
} from "@/lib/api"
import type { DeskBookingResult } from "@/lib/api"
import { addDays, clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
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
  const [fullName, setFullName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [doctorId, setDoctorId] = useState("")
  const [date, setDate] = useState("")
  const [slotId, setSlotId] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [booked, setBooked] = useState<DeskBookingResult | null>(null)

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
    mutationFn: () =>
      apiCreateDeskBooking({
        slotId,
        patient: {
          fullName: fullName.trim(),
          phone: phone.trim(),
          ...(email.trim() !== "" && { email: email.trim() }),
        },
      }),
    onSuccess: (result) => {
      setBooked(result)
      setNotice(result.message)
      setFullName("")
      setPhone("")
      setEmail("")
      setSlotId("")
      void queryClient.invalidateQueries({ queryKey: ["staff"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
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
  const fieldErrors = create.error instanceof ApiError ? create.error.byField() : {}
  const formError =
    create.error instanceof ApiError && create.error.fields.length === 0 ? create.error.message : undefined
  const canSubmit =
    fullName.trim() !== "" && phone.trim() !== "" && slotId !== "" && !create.isPending

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canSubmit) {
      setNotice(null)
      setBooked(null)
      create.mutate()
    }
  }

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
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Patient</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="patient-name">Full name</Label>
              <Input
                id="patient-name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="off"
                maxLength={200}
              />
              {fieldErrors["patient.fullName"] !== undefined && (
                <p className="text-xs text-destructive">{fieldErrors["patient.fullName"]}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-phone">Phone</Label>
              <Input
                id="patient-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                autoComplete="off"
                inputMode="tel"
                placeholder="98765 43210"
              />
              {fieldErrors["patient.phone"] !== undefined && (
                <p className="text-xs text-destructive">{fieldErrors["patient.phone"]}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="patient-email">Email (optional)</Label>
              <Input
                id="patient-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="off"
              />
              {fieldErrors["patient.email"] !== undefined && (
                <p className="text-xs text-destructive">{fieldErrors["patient.email"]}</p>
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
                    setSlotId("")
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
                    setSlotId("")
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

            {fieldErrors["slotId"] !== undefined && (
              <p className="text-xs text-destructive">{fieldErrors["slotId"]}</p>
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
                          onChange={() => setSlotId(slot.slotId)}
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

        {formError !== undefined && (
          <Alert variant="destructive">
            <AlertTitle>Could not create the booking</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {slotId === "" ? "Choose a slot to continue." : "The fee is resolved by the server when the booking is created."}
          </p>
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? "Booking…" : "Create booking"}
          </Button>
        </div>
      </form>
    </div>
  )
}
