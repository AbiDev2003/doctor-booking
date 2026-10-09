import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useSession } from "../../hooks/useSession";
import { apiGetDoctor } from "../../lib/api";
import type { DoctorDetail } from "../../lib/api";
import { formatPaise } from "../../lib/money";

/**
 * §28's landing tab (Day 14): the doctor's own row plus the §5.2 states that
 * matter day to day. The heavy lifting is a plain `GET /doctors/:id` — the
 * same `selfOrStaff` read an admin uses, so there is exactly one detail DTO
 * and one place the row's truth lives.
 */
export default function Overview() {
  const { user } = useSession();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["doctor", user?.id],
    queryFn: () => apiGetDoctor(user!.id).then((r) => r.doctor),
    enabled: user !== null,
  });

  if (isPending || !user) {
    return (
      <div>
        <h1>Overview</h1>
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        <h1>Overview</h1>
        <p role="alert">Your profile could not be loaded.</p>
        <button type="button" className="button-secondary" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1>{data.fullName}</h1>
      <StatusBanner doctor={data} />

      <section className="section">
        <h2>Today</h2>
        <p className="hint">Your live, read-only queue for today's windows.</p>
        <Link className="button-link" to="/doctor/queue">
          Open today's queue →
        </Link>
      </section>

      <section className="section">
        <h2>Your listing</h2>
        <dl className="identity">
          <div>
            <dt>Specialization</dt>
            <dd>{data.specialization ?? "—"}</dd>
          </div>
          <div>
            <dt>Qualification</dt>
            <dd>{data.qualification ?? "—"}</dd>
          </div>
          <div>
            <dt>Consultation fee</dt>
            <dd>{data.consultationFee !== null ? formatPaise(data.consultationFee, "INR") : "Set by the clinic"}</dd>
          </div>
        </dl>
        <Link className="button-link" to="/doctor/profile">
          Edit profile →
        </Link>
      </section>
    </div>
  );
}

/**
 * §5.2's states, rendered as one honest banner. PENDING_VERIFICATION is the
 * one a doctor acts on themselves — it is the §5.2 "credentials changed" state
 * that §26 hides from the public list, so the dashboard is where it must be
 * loud.
 */
function StatusBanner({ doctor }: { doctor: DoctorDetail }) {
  if (doctor.suspendedAt) {
    return (
      <p className="banner" role="alert">
        Your listing is suspended{doctor.suspendReason ? `: ${doctor.suspendReason}` : ""}. You are not currently
        bookable.
      </p>
    );
  }
  if (doctor.verificationStatus === "PENDING_VERIFICATION") {
    return (
      <p className="banner" role="alert">
        You changed a credential detail. Your listing is hidden from the public site until the clinic re-verifies you
        (§5.2).
      </p>
    );
  }
  if (doctor.verificationStatus === "REJECTED") {
    return (
      <p className="banner" role="alert">
        Your verification was rejected.
      </p>
    );
  }
  if (doctor.verificationStatus === "ARCHIVED") {
    return (
      <p className="banner" role="alert">
        Your listing is archived.
      </p>
    );
  }
  return (
    <p className="banner banner-success" role="status">
      {doctor.isBookable ? "Verified and bookable. You appear in the public directory." : "Your profile is awaiting verification."}
    </p>
  );
}