import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarCheck, Clock, ShieldCheck, Stethoscope } from "lucide-react";
import { apiPublicClinic, apiPublicDoctors } from "../lib/api";
import { formatPaise } from "../lib/money";
import { Button } from "@/components/ui/button";
import { DoctorAvatar } from "@/components/doctor-avatar";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-white/60 bg-white/70 px-4 py-3 shadow-sm backdrop-blur">
      <div className="text-2xl font-semibold tracking-tight text-slate-900">{value}</div>
      <div className="text-sm text-slate-600">{label}</div>
    </div>
  );
}

export default function Home() {
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const doctors = useQuery({ queryKey: ["public", "doctors"], queryFn: apiPublicDoctors });

  const featured = doctors.data?.doctors.slice(0, 3) ?? [];
  const currency = clinic.data?.clinic.currency ?? "INR";
  const clinicName = clinic.data?.clinic.name ?? "Clinic";
  const doctorCount = clinic.data?.stats.doctorCount;
  const specializationCount = clinic.data?.stats.specializationCount;

  return (
    <div className="bg-slate-50">
      <section className="relative overflow-hidden border-b border-slate-200/80">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.14),_transparent_45%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.12),_transparent_40%),linear-gradient(to_bottom,_#ffffff,_#f8fafc)]" />
        <div className="relative mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-16 lg:py-24">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-sm font-medium text-primary">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Trusted clinic booking
            </div>

            <h1 className="mt-6 max-w-xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
              Book trusted doctors with confidence.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
              Find verified doctors at {clinicName}, see transparent consultation fees, and choose a time that works for you.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-11 px-6">
                <Link to="/doctors">
                  Browse doctors
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-11 px-6 bg-white/80">
                <a href="#featured-doctors">View featured doctors</a>
              </Button>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <Stat value={doctorCount !== undefined ? String(doctorCount) : "—"} label="Doctors available" />
              <Stat
                value={specializationCount !== undefined ? String(specializationCount) : "—"}
                label="Specializations"
              />
              <Stat
                value={clinic.data?.clinic.bookingHorizonDays !== undefined ? `${clinic.data.clinic.bookingHorizonDays} days` : "—"}
                label="Booking window"
              />
            </div>

            {clinic.isError && (
              <p className="mt-4 text-sm text-slate-500" role="status">
                Clinic details are being set up. You can still browse available doctors.
              </p>
            )}
          </div>

          <div className="relative">
            <div className="absolute -inset-4 rounded-[2rem] bg-blue-100/50 blur-2xl" aria-hidden="true" />
            <div className="relative rounded-[2rem] border border-blue-100 bg-white/90 p-6 shadow-xl shadow-blue-100/40 backdrop-blur sm:p-8">
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-5">
                <div>
                  <p className="text-sm font-medium text-primary">Your care, simplified</p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-900">Easy booking experience</h2>
                </div>
                <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-blue-50 text-primary">
                  <Stethoscope className="size-6" aria-hidden="true" />
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <div className="flex gap-4 rounded-2xl bg-slate-50 p-4">
                  <div className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-primary shadow-sm">
                    <ShieldCheck className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Verified doctors</p>
                    <p className="text-sm leading-6 text-slate-600">Browse profiles with clear qualifications and specializations.</p>
                  </div>
                </div>

                <div className="flex gap-4 rounded-2xl bg-slate-50 p-4">
                  <div className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-primary shadow-sm">
                    <CalendarCheck className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Simple scheduling</p>
                    <p className="text-sm leading-6 text-slate-600">Find available doctors and continue to book in a few steps.</p>
                  </div>
                </div>

                <div className="flex gap-4 rounded-2xl bg-slate-50 p-4">
                  <div className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-primary shadow-sm">
                    <Clock className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Transparent fees</p>
                    <p className="text-sm leading-6 text-slate-600">Consultation fees are shown upfront before you book.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="featured-doctors" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Featured doctors</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Care from professionals you can trust
            </h2>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Explore doctor profiles, specialties, and transparent consultation fees before you book.
            </p>
          </div>
          <Button asChild variant="outline" className="bg-white">
            <Link to="/doctors">
              Browse all doctors
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {doctors.isPending ? (
          <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="size-14 animate-pulse rounded-2xl bg-slate-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-5 w-2/3 animate-pulse rounded bg-slate-200" />
                    <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
                  </div>
                </div>
                <div className="mt-6 space-y-2">
                  <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-4 w-5/6 animate-pulse rounded bg-slate-100" />
                </div>
                <div className="mt-6 h-16 animate-pulse rounded-2xl bg-slate-50" />
                <div className="mt-6 h-10 w-full animate-pulse rounded-md bg-slate-100" />
              </div>
            ))}
          </div>
        ) : doctors.isError ? (
          <div className="mt-10 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-base font-medium text-slate-900">Unable to load doctors</p>
            <p className="mt-2 text-sm text-slate-600" role="alert">
              We couldn&apos;t fetch doctor profiles right now. Please try again.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => void doctors.refetch()}>
              Try again
            </Button>
          </div>
        ) : featured.length > 0 ? (
          <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {featured.map((doctor) => (
              <article
                key={doctor.id}
                className="group flex flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-100 hover:shadow-lg hover:shadow-blue-100/40"
              >
                <div className="flex items-start gap-4">
                  <DoctorAvatar
                    src={doctor.profileImageUrl}
                    name={doctor.fullName}
                    className="size-14 text-base"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-lg font-semibold text-slate-900">{doctor.fullName}</h3>
                    <div className="mt-2 inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-primary">
                      {doctor.specialization ?? "General practice"}
                    </div>
                  </div>
                </div>

                <dl className="mt-6 space-y-3 text-sm">
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-slate-500">Qualification</dt>
                    <dd className="min-w-0 text-slate-700">{doctor.qualification ?? "Qualified medical professional"}</dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-24 shrink-0 text-slate-500">Experience</dt>
                    <dd className="min-w-0 text-slate-700">{doctor.experience ?? "Experience available on profile"}</dd>
                  </div>
                </dl>

                <div className="mt-6 flex items-end justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Consultation fee</p>
                    <p className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
                      {formatPaise(doctor.consultationFee, currency)}
                    </p>
                  </div>
                  <p className="text-xs text-slate-500">Transparent pricing</p>
                </div>

                <Button asChild className="mt-6 w-full">
                  <Link to={`/doctors/${doctor.id}`}>
                    View profile
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-10 rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
              <Stethoscope className="size-6" aria-hidden="true" />
            </div>
            <p className="mt-4 text-lg font-semibold text-slate-900">No doctors available yet</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Doctor profiles will appear here once they are available for booking.
            </p>
            <Button asChild variant="outline" className="mt-5 bg-white">
              <Link to="/doctors">Go to doctors directory</Link>
            </Button>
          </div>
        )}
      </section>

      <section id="cta" className="px-4 pb-16 sm:px-6 lg:pb-20">
        <div className="mx-auto max-w-7xl overflow-hidden rounded-[2rem] border border-blue-100 bg-gradient-to-br from-primary to-blue-700 text-white shadow-xl shadow-blue-200/40">
          <div className="grid gap-10 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-12">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-100">Care made simple</p>
              <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
                Healthcare booking should feel clear, calm, and trustworthy.
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-7 text-blue-50/95">
                From finding the right doctor to understanding consultation fees, we keep the experience simple so you can focus on what matters most — your care.
              </p>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                <div className="flex items-start gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-blue-100" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Verified profiles</p>
                    <p className="mt-1 text-sm text-blue-100/90">Doctor details and specializations you can review.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
                  <CalendarCheck className="mt-0.5 size-5 shrink-0 text-blue-100" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Simple booking</p>
                    <p className="mt-1 text-sm text-blue-100/90">Browse doctors and continue to available appointments.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
                  <Clock className="mt-0.5 size-5 shrink-0 text-blue-100" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Transparent fees</p>
                    <p className="mt-1 text-sm text-blue-100/90">Consultation fees are shown before you book.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 lg:min-w-56">
              <Button asChild size="lg" variant="secondary" className="h-11 bg-white text-primary hover:bg-blue-50">
                <Link to="/doctors">
                  Browse doctors
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <p className="text-center text-sm text-blue-100/90 lg:text-left">
                Find the right doctor and book with confidence.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}