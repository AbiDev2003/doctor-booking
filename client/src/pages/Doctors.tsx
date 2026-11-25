import { useMemo, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRight, Search, Stethoscope, SlidersHorizontal } from "lucide-react"
import { apiPublicClinic, apiPublicDoctors } from "../lib/api"
import { formatPaise } from "../lib/money"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export default function Doctors() {
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic })
  const doctorsQuery = useQuery({ queryKey: ["public", "doctors"], queryFn: apiPublicDoctors })

  const [search, setSearch] = useState("")
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null)

  const currency = clinic.data?.clinic.currency ?? "INR"
  const doctors = doctorsQuery.data?.doctors ?? []

  const specializations = useMemo(() => {
    const set = new Set<string>()
    for (const d of doctors) {
      const spec = d.specialization?.trim()
      if (spec) set.add(spec)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [doctors])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return doctors.filter((d) => {
      const matchesSpec = !selectedSpec || (d.specialization?.trim() ?? "") === selectedSpec
      const matchesSearch =
        !q ||
        d.fullName.toLowerCase().includes(q) ||
        (d.specialization ?? "").toLowerCase().includes(q) ||
        (d.qualification ?? "").toLowerCase().includes(q)
      return matchesSpec && matchesSearch
    })
  }, [doctors, search, selectedSpec])

  return (
    <div className="bg-slate-50">
      <section className="border-b border-slate-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.10),_transparent_45%),linear-gradient(to_bottom,_#ffffff,_#f8fafc)]">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:py-16">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Doctor directory</p>
          <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl lg:text-5xl">
            Find the right doctor for your care
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
            Browse verified doctors, compare specializations and consultation fees, and choose the profile that fits your needs.
          </p>

          <div className="mt-8 grid gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by doctor name, specialization, or qualification"
                className="h-11 bg-white pl-9"
                aria-label="Search doctors"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              <span>{filtered.length} doctor{filtered.length === 1 ? "" : "s"} shown</span>
            </div>
          </div>

          {specializations.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Filter by specialization">
              <FilterChip active={selectedSpec === null} onClick={() => setSelectedSpec(null)}>
                All
              </FilterChip>
              {specializations.map((spec) => (
                <FilterChip
                  key={spec}
                  active={selectedSpec === spec}
                  onClick={() => setSelectedSpec((prev) => (prev === spec ? null : spec))}
                >
                  {spec}
                </FilterChip>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:py-16">
        {doctorsQuery.isPending ? (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="size-14 animate-pulse rounded-2xl bg-slate-200" />
                  <div className="flex-1 space-y-2">
                    <div className="h-5 w-2/3 animate-pulse rounded bg-slate-200" />
                    <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
                  </div>
                </div>
                <div className="mt-5 space-y-2">
                  <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-4 w-4/5 animate-pulse rounded bg-slate-100" />
                </div>
                <div className="mt-6 h-16 animate-pulse rounded-2xl bg-slate-50" />
                <div className="mt-6 h-10 animate-pulse rounded-md bg-slate-100" />
              </div>
            ))}
          </div>
        ) : doctorsQuery.isError ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-lg font-semibold text-slate-900">Unable to load doctors</p>
            <p className="mt-2 text-sm text-slate-600" role="alert">
              We couldn&apos;t fetch the doctor directory right now. Please try again.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => void doctorsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : filtered.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((doctor) => (
              <article
                key={doctor.id}
                className="group flex h-full flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-100 hover:shadow-lg hover:shadow-blue-100/40"
              >
                <div className="flex items-start gap-4">
                  <DoctorAvatar src={doctor.profileImageUrl} name={doctor.fullName} className="size-14 text-base" />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-semibold text-slate-900">{doctor.fullName}</h2>
                    <div className="mt-2">
                      <Badge variant="secondary" className="bg-blue-50 text-primary hover:bg-blue-50">
                        {doctor.specialization ?? "General practice"}
                      </Badge>
                    </div>
                  </div>
                </div>

                <dl className="mt-5 space-y-3 text-sm">
                  <InfoRow label="Qualification" value={doctor.qualification ?? "—"} />
                  <InfoRow label="Experience" value={doctor.experience ?? "—"} />
                  <InfoRow label="Clinic" value={doctor.clinicAssociation ?? "—"} />
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
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary">
              <Stethoscope className="size-6" aria-hidden="true" />
            </div>
            <p className="mt-4 text-lg font-semibold text-slate-900">
              {doctors.length === 0 ? "No doctors available yet" : "No doctors match your search"}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {doctors.length === 0
                ? "Doctor profiles will appear here once they are available for booking."
                : "Try clearing your search or choosing a different specialization."}
            </p>
            {(search || selectedSpec) && doctors.length > 0 && (
              <Button
                variant="outline"
                className="mt-5 bg-white"
                onClick={() => {
                  setSearch("")
                  setSelectedSpec(null)
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-700">{value}</dd>
    </div>
  )
}
