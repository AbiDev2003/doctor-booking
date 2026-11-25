import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, ArrowRight, CalendarDays, CheckCircle2, ClipboardList, Clock, UserRound } from "lucide-react"
import { useSession } from "../../hooks/useSession"
import { apiDoctorToday, apiGetDoctor, ApiError } from "../../lib/api"
import type { DoctorDetail, TodaySlotQueue } from "../../lib/api"
import { formatTimeRange } from "../../lib/clinicDate"
import { formatPaise } from "../../lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Overview() {
  const { user } = useSession()
  const doctor = useQuery({
    queryKey: ["doctor", user?.id],
    queryFn: () => apiGetDoctor(user!.id).then((r) => r.doctor),
    enabled: user !== null,
  })
  const today = useQuery({
    queryKey: ["doctor", "today"],
    queryFn: () => apiDoctorToday().then((r) => r.queue),
  })

  if (!user || doctor.isPending || today.isPending) {
    return <PageLoading label="Loading your dashboard…" />
  }

  if (doctor.isError || today.isError || !doctor.data) {
    const error = doctor.error ?? today.error
    return (
      <PageError
        title="Your dashboard could not be loaded"
        message={error instanceof ApiError ? error.message : undefined}
        onRetry={() => {
          void doctor.refetch()
          void today.refetch()
        }}
      />
    )
  }

  const data = doctor.data
  const windows = today.data.slots
  const booked = windows.reduce((sum, slot) => sum + slot.queue.length, 0)
  const next = nextUp(windows)

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-white via-white to-blue-50/70 p-6 shadow-sm sm:p-8">
        <div className="absolute -right-10 -top-10 size-40 rounded-full bg-blue-100/50 blur-2xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <DoctorAvatar src={data.profileImageUrl} name={data.fullName} className="size-16 text-lg ring-4 ring-white shadow-sm sm:size-20 sm:text-xl" />
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Doctor dashboard</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{data.fullName}</h1>
              <p className="mt-2 text-base text-slate-600">
                {[data.specialization, data.qualification].filter(Boolean).join(" · ") || "Your clinic profile"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/doctor/queue">
                View queue
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="bg-white">
              <Link to="/doctor/profile">Edit profile</Link>
            </Button>
          </div>
        </div>
      </section>

      <StatusBanner doctor={data} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Windows today" value={String(windows.length)} description="Scheduled sessions" icon={<CalendarDays className="size-5" />} />
        <StatCard label="Booked today" value={String(booked)} description="Patients in queue" icon={<ClipboardList className="size-5" />} />
        <StatCard
          label="Up next"
          value={next === null ? "—" : formatTimeRange(next.slot.startTime, next.slot.endTime)}
          description={next === null ? "No pending patient" : "Next patient window"}
          icon={<Clock className="size-5" />}
        />
        <StatCard
          label="Consultation fee"
          value={data.consultationFee !== null ? formatPaise(data.consultationFee, "INR") : "Not set"}
          description="Set by clinic staff"
          icon={<CheckCircle2 className="size-5" />}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl text-slate-950">Today's schedule</CardTitle>
            <CardDescription>{today.data.date} — your windows for today.</CardDescription>
          </CardHeader>
          <CardContent>
            {windows.length === 0 ? (
              <EmptyState
                title="No sessions today"
                description="Your weekly template has no session for today. You can add one on the Schedule tab."
              >
                <Button asChild size="sm" variant="outline" className="bg-white">
                  <Link to="/doctor/schedule">Open schedule</Link>
                </Button>
              </EmptyState>
            ) : (
              <div className="space-y-3">
                {windows.map((slot) => (
                  <div key={slot.slotId} className="flex items-center justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-100">
                    <div>
                      <p className="font-medium text-slate-900">{formatTimeRange(slot.startTime, slot.endTime)}</p>
                      <p className="text-sm text-slate-500">{slot.queue.length} booking{slot.queue.length === 1 ? "" : "s"}</p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="bg-white">
                      <Link to="/doctor/queue">View queue</Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Quick actions</CardTitle>
            <CardDescription>Manage your day-to-day work.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QuickLink to="/doctor/queue" icon={<ClipboardList className="size-4" />} title="Live queue" description="Today's patients, read-only." />
            <QuickLink to="/doctor/schedule" icon={<CalendarDays className="size-4" />} title="Schedule" description="Weekly windows and time off." />
            <QuickLink to="/doctor/profile" icon={<UserRound className="size-4" />} title="Profile" description="Your public listing details." />
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function nextUp(slots: readonly TodaySlotQueue[]): { slot: TodaySlotQueue } | null {
  for (const slot of slots) {
    if (slot.queue.some((entry) => entry.upNext)) return { slot }
  }
  return null
}

function StatCard({ label, value, description, icon }: { label: string; value: string; description: string; icon: ReactNode }) {
  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
            <p className="mt-2 text-sm text-slate-600">{description}</p>
          </div>
          <div className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-primary ring-1 ring-blue-100">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function QuickLink({ to, icon, title, description }: { to: string; icon: ReactNode; title: string; description: string }) {
  return (
    <Link to={to} className="group flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition-all hover:border-blue-100 hover:bg-blue-50/30 hover:shadow-sm">
      <div className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-primary ring-1 ring-blue-100">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-slate-900">{title}</p>
          <ArrowRight className="size-4 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden="true" />
        </div>
        <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
      </div>
    </Link>
  )
}

function StatusBanner({ doctor }: { doctor: DoctorDetail }) {
  if (doctor.suspendedAt) {
    return (
      <Alert variant="destructive" className="rounded-2xl">
        <AlertCircle />
        <AlertTitle>Your listing is suspended</AlertTitle>
        <AlertDescription>
          {doctor.suspendReason ?? "The clinic has paused your listing."} You are not currently bookable.
        </AlertDescription>
      </Alert>
    )
  }
  if (doctor.verificationStatus === "PENDING_VERIFICATION") {
    return (
      <Alert variant="destructive" className="rounded-2xl">
        <AlertCircle />
        <AlertTitle>Awaiting re-verification</AlertTitle>
        <AlertDescription>
          You changed a credential detail. Your listing is hidden from the public site until the clinic re-verifies you.
        </AlertDescription>
      </Alert>
    )
  }
  if (doctor.verificationStatus === "REJECTED") {
    return (
      <Alert variant="destructive" className="rounded-2xl">
        <AlertCircle />
        <AlertTitle>Verification rejected</AlertTitle>
        <AlertDescription>Speak to the clinic about the details that need correcting.</AlertDescription>
      </Alert>
    )
  }
  if (doctor.verificationStatus === "ARCHIVED") {
    return (
      <Alert variant="destructive" className="rounded-2xl">
        <AlertCircle />
        <AlertTitle>Listing archived</AlertTitle>
        <AlertDescription>Your listing is no longer active.</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert className="rounded-2xl border-green-200 bg-green-50/60 text-green-950 [&>svg]:text-green-700">
      <CheckCircle2 />
      <AlertTitle>{doctor.isBookable ? "Verified and bookable" : "Awaiting verification"}</AlertTitle>
      <AlertDescription>
        {doctor.isBookable
          ? "You appear in the public directory and patients can book appointments with you."
          : "Your profile is awaiting clinic verification."}
      </AlertDescription>
    </Alert>
  )
}
