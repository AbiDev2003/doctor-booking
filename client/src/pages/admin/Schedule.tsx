import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiStaffDoctors, ApiError } from "@/lib/api"
import { ScheduleEditor } from "@/pages/doctor/Schedule"
import { SchedulePanel } from "@/pages/staff/Schedule"
import { PageError, PageLoading } from "@/components/async-state"
import { Card, CardContent } from "@/components/ui/card"

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * §29's schedule tab (Day 33): pick a doctor, edit their recurring template,
 * then work the dated day slots. The two editors are the doctor and front-desk
 * components, not copies, so a template fix and a day fix stay one behaviour.
 */
export default function Schedule() {
  const [doctorId, setDoctorId] = useState("")
  const doctors = useQuery({ queryKey: ["staff", "doctors"], queryFn: ({ signal }) => apiStaffDoctors(signal) })
  const selected = doctorId !== "" ? doctorId : (doctors.data?.doctors[0]?.id ?? "")

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Schedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit a doctor's weekly template, time off, and the slots for a specific day.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Doctor</span>
            <select className={SELECT_CLASS} value={selected} onChange={(event) => setDoctorId(event.target.value)}>
              {doctors.data?.doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                </option>
              ))}
            </select>
          </label>
        </CardContent>
      </Card>

      {selected !== "" ? (
        <>
          <ScheduleEditor
            key={`template-${selected}`}
            doctorId={selected}
            title="Weekly template"
            description="Recurring windows generate the public bookable slots for this doctor."
          />
          <SchedulePanel key={`day-${selected}`} initialDoctorId={selected} />
        </>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Invite and verify a doctor before editing a schedule.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
