import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, CalendarDays, Clock, CreditCard, MapPin, ShieldCheck, Wallet } from "lucide-react"
import {
  apiBookSlot,
  apiCreatePaymentOrder,
  apiPublicClinic,
  apiPublicDoctor,
  apiPublicDoctorAvailability,
  apiVerifyPayment,
  ApiError,
} from "../lib/api"
import type { Appointment, PublicAvailabilitySlot } from "../lib/api"
import { openRazorpayCheckout } from "../lib/razorpay"
import { useSession } from "../hooks/useSession"
import { formatPaise } from "../lib/money"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function clinicToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${read("year")}-${read("month")}-${read("day")}`
}

function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function bookingErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "SLOT_FULL":
        return "Sorry — that seat was just taken. Please pick another time."
      case "ALREADY_BOOKED":
        return "You already have a booking for this slot."
      case "EMAIL_NOT_VERIFIED":
        return "Please verify your email address before booking."
      case "SLOT_STARTED":
        return "That slot has already started. Please pick another time."
      case "DOCTOR_UNAVAILABLE":
        return "The doctor is unavailable at that time. Please pick another slot."
      case "BOOKING_OUTSIDE_HORIZON":
        return "That date is outside the clinic's booking window."
      default:
        return err.message
    }
  }
  return "Something went wrong. Please try again."
}

function paymentErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "PAYMENTS_NOT_CONFIGURED":
        return "Online payments aren't set up on this server yet — please pay at the clinic."
      case "PAYMENT_GATEWAY_ERROR":
        return "We couldn't start the payment. Please try again, or pay at the clinic."
      case "PAYMENT_ORDER_CONFLICT":
        return "That payment session is no longer open. Please start again."
      case "PAYMENT_SIGNATURE_INVALID":
        return "The payment could not be verified. Please contact the clinic — you will not be charged twice."
      case "PAYMENT_NOT_PENDING":
        return "This payment has already been settled. Please check your bookings."
      case "HOLD_EXPIRED":
        return "The reservation expired before payment finished — you have not been charged. Please try again."
      case "HOLD_RELEASED":
      case "HOLD_NOT_FOUND":
        return "The reserved seat is no longer yours — you have not been charged. Please try again."
      case "CONVERSION_FAILED":
        return "We couldn't complete your booking after payment. The clinic will follow up — you will not be charged without a booking."
      case "ZERO_CONSULTATION_FEE":
        return "No fee is payable online for this consultation — please book at the clinic."
      default:
        return bookingErrorMessage(err)
    }
  }
  return "Something went wrong. Please try again."
}

export default function DoctorProfile() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { user, isAuthenticated, isLoading: sessionLoading } = useSession()

  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["public", "doctor", id],
    queryFn: () => apiPublicDoctor(id),
  })

  const timezone = clinic.data?.clinic.timezone
  const horizonDays = clinic.data?.clinic.bookingHorizonDays
  const minDate = timezone ? clinicToday(timezone) : ""
  const maxDate = minDate && horizonDays !== undefined ? addDays(minDate, horizonDays) : ""

  const [pickedDate, setPickedDate] = useState<string | null>(null)
  const selectedDate = pickedDate ?? (minDate || null)

  const availability = useQuery({
    queryKey: ["public", "availability", id, selectedDate],
    queryFn: () => apiPublicDoctorAvailability(id, selectedDate as string),
    enabled: id !== "" && selectedDate !== null,
  })

  const [bookingSlotId, setBookingSlotId] = useState<string | null>(null)
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Appointment | null>(null)

  const [payingSlotId, setPayingSlotId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null)

  async function book(slot: PublicAvailabilitySlot) {
    if (sessionLoading) return
    if (!isAuthenticated) {
      navigate(`/login?returnTo=${encodeURIComponent(`/doctors/${id}`)}`)
      return
    }
    if (user?.role !== "PATIENT") {
      setBookingError("Only patient accounts can book online. Please contact the front desk.")
      return
    }
    setBookingError(null)
    setPaymentError(null)
    setPaymentNotice(null)
    setBookingSlotId(slot.slotId)
    try {
      const { appointment } = await apiBookSlot(slot.slotId)
      setConfirmation(appointment)
      void availability.refetch()
    } catch (err) {
      setBookingError(bookingErrorMessage(err))
    } finally {
      setBookingSlotId(null)
    }
  }

  async function payOnline(slot: PublicAvailabilitySlot) {
    if (sessionLoading) return
    if (!isAuthenticated) {
      navigate(`/login?returnTo=${encodeURIComponent(`/doctors/${id}`)}`)
      return
    }
    if (user?.role !== "PATIENT") {
      setPaymentError("Only patient accounts can pay online. Please contact the front desk.")
      return
    }
    setPaymentError(null)
    setPaymentNotice(null)
    setBookingError(null)
    setPayingSlotId(slot.slotId)
    try {
      const { order } = await apiCreatePaymentOrder(slot.slotId)
      const outcome = await openRazorpayCheckout(order, { merchantName: clinic.data?.clinic.name })
      if (outcome === "dismissed") {
        setPaymentNotice("Checkout closed — you have not been charged. Press Pay online to try again.")
        return
      }
      setConfirming(true)
      try {
        const { appointment } = await apiVerifyPayment(outcome)
        setConfirmation(appointment)
        void availability.refetch()
      } catch (err) {
        if (err instanceof ApiError) {
          setPaymentError(paymentErrorMessage(err))
        } else {
          setPaymentNotice("Payment received — your booking will complete automatically within minutes.")
        }
      } finally {
        setConfirming(false)
      }
    } catch (err) {
      setPaymentError(paymentErrorMessage(err))
    } finally {
      setPayingSlotId(null)
    }
  }

  if (isPending) {
    return (
      <div className="bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
          <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="size-20 animate-pulse rounded-2xl bg-slate-200" />
                <div className="space-y-2">
                  <div className="h-7 w-48 animate-pulse rounded bg-slate-200" />
                  <div className="h-5 w-32 animate-pulse rounded bg-slate-100" />
                </div>
              </div>
              <div className="mt-6 space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-50" />
                ))}
              </div>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="h-7 w-56 animate-pulse rounded bg-slate-200" />
              <div className="mt-4 h-11 w-full animate-pulse rounded-md bg-slate-100" />
              <div className="mt-6 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-50" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-lg font-semibold text-slate-900">Doctor not found</p>
            <p className="mt-2 text-sm text-slate-600" role="alert">
              This doctor profile is not available. They may no longer be accepting bookings.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link to="/doctors">
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back to all doctors
                </Link>
              </Button>
              {isError && (
                <Button variant="ghost" onClick={() => void refetch()}>
                  Try again
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const { doctor } = data
  const currency = clinic.data?.clinic.currency ?? "INR"
  const slots = availability.data?.availability ?? []

  return (
    <div className="bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
        <Button asChild variant="ghost" className="-ml-3 mb-6 text-slate-600 hover:text-slate-900">
          <Link to="/doctors">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to all doctors
          </Link>
        </Button>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] xl:gap-8">
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <DoctorAvatar src={doctor.profileImageUrl} name={doctor.fullName} className="size-20 text-xl sm:size-24 sm:text-2xl" />
              <div className="min-w-0">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Doctor profile</p>
                <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{doctor.fullName}</h1>
                <div className="mt-3">
                  <Badge variant="secondary" className="bg-blue-50 text-primary hover:bg-blue-50">
                    {doctor.specialization ?? "General practice"}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <InfoCard icon={<ShieldCheck className="size-4" />} label="Qualification" value={doctor.qualification ?? "—"} />
              <InfoCard icon={<Clock className="size-4" />} label="Experience" value={doctor.experience ?? "—"} />
              <InfoCard icon={<MapPin className="size-4" />} label="Practice" value={doctor.clinicAssociation ?? "—"} />
              <InfoCard icon={<Wallet className="size-4" />} label="Consultation fee" value={formatPaise(doctor.consultationFee, currency)} highlight />
            </div>

            <div className="mt-8 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              <p className="font-medium text-slate-900">Before you book</p>
              <p className="mt-1">Choose an available date and slot. You can pay online now or book and pay at the clinic.</p>
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Appointments</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Book an appointment</h2>
                <p className="mt-2 text-sm text-slate-600">Select a date to see available slots for this doctor.</p>
              </div>
              <div className="hidden rounded-2xl bg-blue-50 p-3 text-primary sm:inline-flex">
                <CalendarDays className="size-5" aria-hidden="true" />
              </div>
            </div>

            {confirmation ? (
              <div className="mt-6 rounded-2xl border border-green-200 bg-green-50/70 p-5" role="status">
                <p className="text-lg font-semibold text-green-900">Booking confirmed</p>
                <p className="mt-1 text-sm text-green-800">Your appointment has been booked successfully.</p>
                <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                  <ConfirmRow label="Doctor" value={confirmation.doctorName} />
                  <ConfirmRow label="Date" value={confirmation.slotDate} />
                  <ConfirmRow label="Time" value={`${confirmation.startTime}–${confirmation.endTime}`} />
                  <ConfirmRow label="Fee" value={formatPaise(confirmation.feeAmount, currency)} />
                </dl>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Button type="button" variant="outline" className="bg-white" onClick={() => setConfirmation(null)}>
                    Book another appointment
                  </Button>
                  <Button asChild>
                    <Link to="/doctors">Browse doctors</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-6 space-y-5">
                <div className="space-y-2">
                  <label htmlFor="slot-date" className="text-sm font-medium text-slate-900">Choose a date</label>
                  <Input
                    id="slot-date"
                    type="date"
                    min={minDate}
                    max={maxDate}
                    value={selectedDate ?? ""}
                    onChange={(event) => setPickedDate(event.target.value)}
                    className="h-11 max-w-xs bg-white"
                  />
                </div>

                {bookingError && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not book slot</AlertTitle>
                    <AlertDescription>{bookingError}</AlertDescription>
                  </Alert>
                )}
                {paymentError && (
                  <Alert variant="destructive">
                    <AlertTitle>Payment could not be completed</AlertTitle>
                    <AlertDescription>{paymentError}</AlertDescription>
                  </Alert>
                )}
                {paymentNotice && (
                  <Alert>
                    <AlertTitle>Payment notice</AlertTitle>
                    <AlertDescription>{paymentNotice}</AlertDescription>
                  </Alert>
                )}

                {minDate === "" ? (
                  <p className="text-sm text-slate-500">Loading available dates…</p>
                ) : availability.isPending ? (
                  <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />
                    ))}
                  </div>
                ) : availability.isError ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-medium text-slate-900">Availability could not be loaded.</p>
                    <Button variant="outline" size="sm" className="mt-3 bg-white" onClick={() => void availability.refetch()}>
                      Retry
                    </Button>
                  </div>
                ) : slots.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center">
                    <p className="font-medium text-slate-900">No bookable slots on this date</p>
                    <p className="mt-1 text-sm text-slate-600">Try selecting another date.</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {slots.map((slot) => {
                      const isBooking = bookingSlotId === slot.slotId
                      const isPaying = payingSlotId === slot.slotId
                      const busy = sessionLoading || bookingSlotId !== null || payingSlotId !== null
                      return (
                        <li key={slot.slotId} className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-base font-semibold text-slate-900">{slot.startTime}–{slot.endTime}</p>
                            <p className="mt-1 text-sm text-slate-600">{slot.remaining} {slot.remaining === 1 ? "seat" : "seats"} left</p>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button type="button" variant="outline" className="bg-white" onClick={() => void book(slot)} disabled={busy}>
                              <CalendarDays className="size-4" aria-hidden="true" />
                              {isBooking ? "Booking…" : "Book"}
                            </Button>
                            <Button type="button" onClick={() => void payOnline(slot)} disabled={busy}>
                              <CreditCard className="size-4" aria-hidden="true" />
                              {isPaying ? (confirming ? "Confirming…" : "Opening…") : "Pay online"}
                            </Button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}

                <p className="text-xs text-slate-500">Pay online now, or book and pay at the clinic when you visit.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function InfoCard({
  icon,
  label,
  value,
  highlight = false,
}: {
  icon: ReactNode
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
        <span className="text-primary">{icon}</span>
        {label}
      </div>
      <p className={["mt-2 text-sm", highlight ? "text-lg font-semibold text-slate-950" : "text-slate-800"].join(" ")}>{value}</p>
    </div>
  )
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/80 px-3 py-2 ring-1 ring-green-100">
      <dt className="text-xs font-medium uppercase tracking-wide text-green-700">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{value}</dd>
    </div>
  )
}
