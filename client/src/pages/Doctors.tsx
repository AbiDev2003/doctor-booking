import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiPublicClinic, apiPublicDoctors } from "../lib/api";
import { formatPaise } from "../lib/money";
import { useSession } from "../hooks/useSession";

/**
 * §26's full directory (Day 13). Specialization filters are D5's choice: no
 * server endpoint — the chips derive from what the list already returns, so a
 * refetch cannot desynchronise the chips from the data. Filtering is purely
 * cosmetic, hence client-side by design; invalidation (a suspension, an
 * un-verified doctor) happens server-side on refetch and the chips doctor
 * themselves by consequence.
 */
export default function Doctors() {
  const { user } = useSession();
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["public", "doctors"],
    queryFn: apiPublicDoctors,
  });
  const currency = clinic.data?.clinic.currency ?? "INR";
  const [specialization, setSpecialization] = useState<string | null>(null);

  const specializations = useMemo(() => {
    const seen = new Set<string>();
    for (const doctor of data?.doctors ?? []) {
      if (doctor.specialization) seen.add(doctor.specialization);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const doctors = useMemo(() => {
    const list = data?.doctors ?? [];
    return specialization ? list.filter((d) => d.specialization === specialization) : list;
  }, [data, specialization]);

  if (isPending) {
    return (
      <div>
        <h1>Our doctors</h1>
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <h1>Our doctors</h1>
        <p role="alert">The directory could not be loaded.</p>
        <button type="button" className="button-secondary" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1>Our doctors</h1>

      {specializations.length > 1 && (
        <div className="chip-row" role="group" aria-label="Filter by specialization">
          <button type="button" className={specialization === null ? "chip chip--active" : "chip"} onClick={() => setSpecialization(null)}>
            All
          </button>
          {specializations.map((name) => (
            <button
              key={name}
              type="button"
              className={specialization === name ? "chip chip--active" : "chip"}
              onClick={() => setSpecialization(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {doctors.length === 0 ? (
        <p className="hint">No doctors match this filter.</p>
      ) : (
        <ul className="doctor-grid">
          {doctors.map((doctor) => (
            <li key={doctor.id} className="card card--doctor">
              <div>
                <h3>{doctor.fullName}</h3>
                <p className="hint">
                  {doctor.specialization ?? "General practice"}
                  {doctor.qualification ? ` · ${doctor.qualification}` : ""}
                </p>
                {doctor.experience && <p className="hint">{doctor.experience}</p>}
                <p className="doctor-grid__fee">{formatPaise(doctor.consultationFee, currency)}</p>
              </div>
              <Link className="button-link" to={`/doctors/${doctor.id}`}>
                View profile
              </Link>
            </li>
          ))}
        </ul>
      )}

      {user && user.role === "DOCTOR" && (
        <p className="hint">
          This is the public directory. To manage your own listing, go to your <Link to="/doctor/profile">profile</Link>.
        </p>
      )}
    </div>
  );
}