import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiStaffDoctors, ApiError } from "@/lib/api"
import { ScheduleEditor } from "@/pages/doctor/Schedule"
import { SchedulePanel } from "@/pages/staff/Schedule"
import { PageError, PageLoading } from "@/components/async-state"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export default function Schedule() {
  const [doctorId, setDoctorId] = useState("")
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: ({ signal }) => apiStaffDoctors(signal) })
  const selected = doctorId !== "" ? doctorId : (doctors.data?.doctors.find((doctor) => doctor.isBookable)?.id ?? "")

  if (doctors.isPending) return <PageLoading label="Loading doctors…" />
  if (doctors.isError) {
    return (
      <PageError
        title="Doctors could not be loaded"
        message={doctors.error instanceof ApiError ? doctors.error.message : undefined}
        onRetry={() => void doctors.refetch()}
      />
    )
  }

  const doctorOptions = doctors.data.doctors.filter((doctor) => doctor.isBookable)

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Schedule</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Doctor schedule</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Pick a doctor, edit their recurring template, then manage dated day slots and unavailability.
        </p>
      </section>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Doctor</CardTitle>
          <CardDescription>Select which doctor’s schedule to manage.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-md space-y-2">
            <Label htmlFor="admin-schedule-doctor">Doctor</Label>
            <select id="admin-schedule-doctor" className={SELECT_CLASS} value={selected} onChange={(event) => setDoctorId(event.target.value)}>
              {doctorOptions.length === 0 && <option value="">No verified doctors available</option>}
              {doctorOptions.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                  {doctor.specialization !== null ? ` · ${doctor.specialization}` : ""}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {selected !== "" && (
        <>
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Weekly template</h2>
              <p className="text-sm text-slate-600">The recurring pattern this doctor’s dated slots are generated from.</p>
            </div>
            <ScheduleEditor doctorId={selected} />
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Day slots and disruptions</h2>
              <p className="text-sm text-slate-600">Dated fixes for a specific day: add, edit, disable, or mark unavailable.</p>
            </div>
            <SchedulePanel initialDoctorId={selected} />
          </section>
        </>
      )}
    </div>
  )
}
