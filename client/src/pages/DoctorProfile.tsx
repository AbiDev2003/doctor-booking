import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { apiPublicClinic, apiPublicDoctor, apiPublicDoctorAvailability } from "../lib/api";
import { formatPaise } from "../lib/money";

/**
 * §26's profile page (Day 13), with Day 17's anonymous slot picker.
 *
 * The profile itself is everything an anonymous visitor can know, rendered from
 * the public DTO — which deliberately ships no licenseNumber, no email, no
 * verification status. A suspended or unverified doctor answers 404 from the
 * API (never a "this doctor exists but is hidden" 403), which this page
 * surfaces as the generic "not found".
 *
 * The picker is read-only by design (Day 17): it lists only genuinely bookable
 * slots the server vouches for (`/public/doctors/:id/availability`) and its
 * Book button is disabled, because the booking transaction (and its seat hold)
 * arrives on Day 19. Showing a real slot list with an honest "coming soon"
 * beats a fake success that a patient would believe.
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

        {minDate === "" ? (
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
                    <button type="button" className="slot-row__book" disabled>
                      Book
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="hint">Online booking opens soon — the times above are shown for reference.</p>
          </>
        )}
      </section>
    </div>
  );
}
