import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  apiBookSlot,
  apiCreatePaymentOrder,
  apiPublicClinic,
  apiPublicDoctor,
  apiPublicDoctorAvailability,
  apiVerifyPayment,
  ApiError,
} from "../lib/api";
import type { Appointment, PublicAvailabilitySlot } from "../lib/api";
import { openRazorpayCheckout } from "../lib/razorpay";
import { useSession } from "../hooks/useSession";
import { formatPaise } from "../lib/money";

/**
 * §26's profile page (Day 13), with Day 17's anonymous slot picker, Day 19's
 * booking, and Day 23's online checkout.
 *
 * The profile itself is everything an anonymous visitor can know, rendered from
 * the public DTO — which deliberately ships no licenseNumber, no email, no
 * verification status. A suspended or unverified doctor answers 404 from the
 * API (never a "this doctor exists but is hidden" 403), which this page
 * surfaces as the generic "not found".
 *
 * The picker lists only genuinely bookable slots the server vouches for
 * (`/public/doctors/:id/availability`). Each slot offers BOTH §17 paths as two
 * explicit buttons, because they are two different server flows, not a mode
 * flag: **Book** is Day 19's pay-at-clinic (appointment born `CONFIRMED`
 * immediately), **Pay online** is Days 23–24's order → checkout → verify: the
 * server reserves the seat with a `SeatHold` before asking for money, and the
 * appointment is born `CONFIRMED` only when the verified payment converts that
 * hold (exactly once, replay-safe). Pressing either is where Day 17's honest
 * "coming soon" gives way to the real transaction: a signed-out visitor is
 * sent to sign in (and returned here), a non-patient is told to use the desk,
 * and a stale listing can only ever fail cleanly — the server re-checks every
 * condition inside its own transaction.
 *
 * The date input is bounded to the clinic's own `[today, today +
 * bookingHorizonDays]` — the same window the server enforces — computed in the
 * CLINIC's timezone so the "today" a patient sees matches the day the server
 * filters by (§3.2).
 */

/** Today's calendar date in `timeZone`, as `YYYY-MM-DD`. */
function clinicToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

/** `date` shifted by `days` calendar days, as `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A booking refusal, phrased for a patient rather than as a bare code. */
function bookingErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "SLOT_FULL":
        return "Sorry — that seat was just taken. Please pick another time.";
      case "ALREADY_BOOKED":
        return "You already have a booking for this slot.";
      case "EMAIL_NOT_VERIFIED":
        return "Please verify your email address before booking.";
      case "SLOT_STARTED":
        return "That slot has already started. Please pick another time.";
      case "DOCTOR_UNAVAILABLE":
        return "The doctor is unavailable at that time. Please pick another slot.";
      case "BOOKING_OUTSIDE_HORIZON":
        return "That date is outside the clinic's booking window.";
      default:
        return err.message;
    }
  }
  return "Something went wrong. Please try again.";
}

/**
 * An online-payment refusal (Days 23–24), phrased the same way. The
 * payment-specific codes come from `paymentOrder.service.ts` /
 * `paymentConvert.service.ts`; everything else (SLOT_FULL, ALREADY_BOOKED,
 * BOOKING_CAP_REACHED, …) is the shared booking guard the hold transaction
 * reuses, so those fall through to `bookingErrorMessage` — one phrase per code
 * across both flows rather than two phrasings of one refusal. The local
 * un-keyed-`.env` state points back at pay-at-clinic instead of looking like
 * an outage.
 */
function paymentErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "PAYMENTS_NOT_CONFIGURED":
        return "Online payments aren't set up on this server yet — please pay at the clinic.";
      case "PAYMENT_GATEWAY_ERROR":
        return "We couldn't start the payment. Please try again, or pay at the clinic.";
      case "PAYMENT_ORDER_CONFLICT":
        return "That payment session is no longer open. Please start again.";
      case "PAYMENT_SIGNATURE_INVALID":
        return "The payment could not be verified. Please contact the clinic — you will not be charged twice.";
      case "PAYMENT_NOT_PENDING":
        return "This payment has already been settled. Please check your bookings.";
      case "HOLD_EXPIRED":
        return "The reservation expired before payment finished — you have not been charged. Please try again.";
      case "HOLD_RELEASED":
      case "HOLD_NOT_FOUND":
        return "The reserved seat is no longer yours — you have not been charged. Please try again.";
      case "CONVERSION_FAILED":
        return "We couldn't complete your booking after payment. The clinic will follow up — you will not be charged without a booking.";
      case "ZERO_CONSULTATION_FEE":
        return "No fee is payable online for this consultation — please book at the clinic.";
      default:
        // The §8.5/§10/§15 guards the hold transaction shares with booking.
        return bookingErrorMessage(err);
    }
  }
  return "Something went wrong. Please try again.";
}

export default function DoctorProfile() {
  const { id = "" } = useParams();
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["public", "doctor", id],
    queryFn: () => apiPublicDoctor(id),
  });

  const timezone = clinic.data?.clinic.timezone;
  const horizonDays = clinic.data?.clinic.bookingHorizonDays;
  const minDate = timezone ? clinicToday(timezone) : "";
  const maxDate = minDate && horizonDays !== undefined ? addDays(minDate, horizonDays) : "";

  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const selectedDate = pickedDate ?? (minDate || null);

  const availability = useQuery({
    queryKey: ["public", "availability", id, selectedDate],
    queryFn: () => apiPublicDoctorAvailability(id, selectedDate as string),
    enabled: id !== "" && selectedDate !== null,
  });

  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading: sessionLoading } = useSession();

  const [bookingSlotId, setBookingSlotId] = useState<string | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Appointment | null>(null);

  const [payingSlotId, setPayingSlotId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);

  async function book(slot: PublicAvailabilitySlot) {
    if (sessionLoading) return;
    if (!isAuthenticated) {
      // Send the visitor to sign in, then straight back here (§26 storefront).
      navigate(`/login?returnTo=${encodeURIComponent(`/doctors/${id}`)}`);
      return;
    }
    if (user?.role !== "PATIENT") {
      setBookingError("Only patient accounts can book online. Please contact the front desk.");
      return;
    }
    setBookingError(null);
    setBookingSlotId(slot.slotId);
    try {
      const { appointment } = await apiBookSlot(slot.slotId);
      setConfirmation(appointment);
      void availability.refetch();
    } catch (err) {
      setBookingError(bookingErrorMessage(err));
    } finally {
      setBookingSlotId(null);
    }
  }

  /**
   * The full §17 loop, Days 23+24: create the hold + order, open the hosted
   * checkout, and on completion POST the gateway's triple to /payments/verify,
   * which converts the hold into exactly one CONFIRMED appointment (or names
   * the refusal). The confirmation panel and the availability refetch reuse
   * booking's own — the two flows converge on one rendered result.
   *
   * The one non-ApiError case is kept deliberately optimistic: if the verify
   * call itself dies (network, not business refusal), the payment DID happen
   * and the server-side webhook will finish the conversion — saying "you will
   * be charged without a booking" there would be a lie, and saying "failed"
   * would send the patient to pay again.
   */
  async function payOnline(slot: PublicAvailabilitySlot) {
    if (sessionLoading) return;
    if (!isAuthenticated) {
      navigate(`/login?returnTo=${encodeURIComponent(`/doctors/${id}`)}`);
      return;
    }
    if (user?.role !== "PATIENT") {
      setPaymentError("Only patient accounts can pay online. Please contact the front desk.");
      return;
    }
    setPaymentError(null);
    setPaymentNotice(null);
    setPayingSlotId(slot.slotId);
    try {
      const { order } = await apiCreatePaymentOrder(slot.slotId);
      const outcome = await openRazorpayCheckout(order, { merchantName: clinic.data?.clinic.name });
      if (outcome === "dismissed") {
        setPaymentNotice("Checkout closed — you have not been charged. Press Pay online to try again.");
        return;
      }
      setConfirming(true);
      try {
        const { appointment } = await apiVerifyPayment(outcome);
        setConfirmation(appointment);
        void availability.refetch();
      } catch (err) {
        if (err instanceof ApiError) {
          setPaymentError(paymentErrorMessage(err));
        } else {
          setPaymentNotice("Payment received — your booking will complete automatically within minutes.");
        }
      } finally {
        setConfirming(false);
      }
    } catch (err) {
      setPaymentError(paymentErrorMessage(err));
    } finally {
      setPayingSlotId(null);
    }
  }

  if (isPending) {
    return (
      <div>
        <h1>Doctor profile</h1>
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        <h1>Doctor not found</h1>
        <p role="alert">
          This profile is not available — the doctor may have been suspended, is awaiting re-verification, or the link
          is wrong.
        </p>
        <Link className="button-link" to="/doctors">
          ← Back to all doctors
        </Link>
        {isError && (
          <button type="button" className="button-secondary" onClick={() => void refetch()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  const { doctor } = data;
  const currency = clinic.data?.clinic.currency ?? "INR";
  const slots = availability.data?.availability ?? [];

  return (
    <div>
      <Link className="button-link" to="/doctors">
        ← Back to all doctors
      </Link>

      <h1>{doctor.fullName}</h1>
      <p className="hint">{doctor.specialization ?? "General practice"}</p>

      <dl className="identity">
        <div>
          <dt>Qualification</dt>
          <dd>{doctor.qualification ?? "—"}</dd>
        </div>
        <div>
          <dt>Experience</dt>
          <dd>{doctor.experience ?? "—"}</dd>
        </div>
        <div>
          <dt>Practice</dt>
          <dd>{doctor.clinicAssociation ?? "—"}</dd>
        </div>
        <div>
          <dt>Consultation fee</dt>
          <dd>{formatPaise(doctor.consultationFee, currency)}</dd>
        </div>
      </dl>

      <section className="section">
        <h2>Book an appointment</h2>

        {confirmation ? (
          <div className="booking-confirmation" role="status">
            <p>
              <strong>Booked!</strong> Your appointment is confirmed.
            </p>
            <dl className="identity">
              <div>
                <dt>Doctor</dt>
                <dd>{confirmation.doctorName}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{confirmation.slotDate}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>
                  {confirmation.startTime}–{confirmation.endTime}
                </dd>
              </div>
              <div>
                <dt>Fee</dt>
                <dd>
                  {formatPaise(confirmation.feeAmount, currency)} <span className="hint">— pay at the clinic</span>
                </dd>
              </div>
            </dl>
            <button type="button" className="button-secondary" onClick={() => setConfirmation(null)}>
              Book another appointment
            </button>
          </div>
        ) : minDate === "" ? (
          <p className="hint">Loading available dates…</p>
        ) : (
          <>
            <label htmlFor="slot-date">Choose a date</label>
            <input
              id="slot-date"
              type="date"
              min={minDate}
              max={maxDate}
              value={selectedDate ?? ""}
              onChange={(event) => setPickedDate(event.target.value)}
            />

            {bookingError && (
              <p className="form-error" role="alert">
                {bookingError}
              </p>
            )}

            {paymentError && (
              <p className="form-error" role="alert">
                {paymentError}
              </p>
            )}

            {paymentNotice && (
              <p className="hint" role="status">
                {paymentNotice}
              </p>
            )}

            {availability.isPending ? (
              <p className="hint">Checking slots…</p>
            ) : availability.isError ? (
              <p role="alert">Availability could not be loaded. Please try again shortly.</p>
            ) : slots.length === 0 ? (
              <p className="hint">No bookable slots on this date.</p>
            ) : (
              <ul className="slot-list">
                {slots.map((slot) => (
                  <li key={slot.slotId} className="slot-row">
                    <span className="slot-row__time">
                      {slot.startTime}–{slot.endTime}
                    </span>
                    <span className="hint">
                      {slot.remaining} {slot.remaining === 1 ? "seat" : "seats"} left
                    </span>
                    {/* Two flows, two server paths (§17): a pay-at-clinic booking
                        born CONFIRMED, or a hold-first online payment whose seat
                        is reserved before checkout and converted to CONFIRMED by
                        /payments/verify. One action at a time, so the two can't
                        interleave in the UI. */}
                    <span className="slot-row__actions">
                      <button
                        type="button"
                        className="slot-row__book"
                        onClick={() => void book(slot)}
                        disabled={sessionLoading || bookingSlotId !== null || payingSlotId !== null}
                      >
                        {bookingSlotId === slot.slotId ? "Booking…" : "Book"}
                      </button>
                      <button
                        type="button"
                        className="slot-row__pay"
                        onClick={() => void payOnline(slot)}
                        disabled={sessionLoading || bookingSlotId !== null || payingSlotId !== null}
                      >
                        {payingSlotId === slot.slotId
                          ? confirming
                            ? "Confirming…"
                            : "Opening…"
                          : "Pay online"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="hint">Pay online now, or pay at the clinic when you visit.</p>
          </>
        )}
      </section>
    </div>
  );
}
