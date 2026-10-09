import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { apiPublicClinic, apiPublicDoctor } from "../lib/api";
import { formatPaise } from "../lib/money";

/**
 * §26's profile page (Day 13): everything an anonymous visitor can know,
 * rendered from the public DTO — which deliberately ships no licenseNumber,
 * no email, no verification status. The Book button therefore exists but is
 * disabled (D8): honest that booking is coming on Day 15, without a link that
 * would 404 later.
 *
 * A suspended or unverified doctor answers 404 from the API (never a "this
 * doctor exists but is hidden" 403), which this page surfaces as the generic
 * "not found" — so the client cannot distinguish a hidden doctor from a bad
 * id, which is exactly the point.
 */
export default function DoctorProfile() {
  const { id = "" } = useParams();
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["public", "doctor", id],
    queryFn: () => apiPublicDoctor(id),
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

      <button type="button" disabled>
        Book an appointment — available soon
      </button>
      <p className="hint">Online booking arrives with scheduling (Day 15). </p>
    </div>
  );
}