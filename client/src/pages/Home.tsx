import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiPublicClinic, apiPublicDoctors } from "../lib/api";
import { formatPaise } from "../lib/money";

/**
 * §26 storefront landing (Day 13). Two promises: the numbers on the page are
 * real (statistics are derived from bookable doctors by the server, never
 * invented by the markup), and it never fails hard — if the clinic isn't
 * configured or nothing is bookable yet, the sections shrink and the hero
 * carries the message. There is no secret behind a skeleton spinner for data
 * that is inherently "start here".
 */
export default function Home() {
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const doctors = useQuery({ queryKey: ["public", "doctors"], queryFn: apiPublicDoctors });

  const featured = doctors.data?.doctors.slice(0, 3) ?? [];
  const currency = clinic.data?.clinic.currency ?? "INR";

  return (
    <div className="hero">
      <h1>{clinic.data?.clinic.name ?? "Clinic"}</h1>
      <p className="hint">
        Book a consultation with a verified doctor. Fees shown are the desk price.
        {clinic.isError && " The clinic hasn't set up its profiles yet."}
      </p>

      {clinic.data && (
        <p className="hero__stats">
          <strong>{clinic.data.stats.doctorCount}</strong> doctors available
          <span aria-hidden="true"> · </span>
          <strong>{clinic.data.stats.specializationCount}</strong> specializations
        </p>
      )}

      {featured.length > 0 && (
        <section>
          <h2>Featured doctors</h2>
          <ul className="doctor-grid">
            {featured.map((doctor) => (
              <li key={doctor.id} className="card card--doctor">
                <div>
                  <h3>{doctor.fullName}</h3>
                  <p className="hint">
                    {doctor.specialization ?? "General practice"}
                    {doctor.qualification ? ` · ${doctor.qualification}` : ""}
                  </p>
                  <p className="doctor-grid__fee">{formatPaise(doctor.consultationFee, currency)}</p>
                </div>
                <Link className="button-link" to={`/doctors/${doctor.id}`}>
                  View profile
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link className="button-link" to="/doctors">
        Browse all doctors →
      </Link>
    </div>
  );
}