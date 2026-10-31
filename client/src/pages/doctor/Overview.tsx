import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { AlertCircle, CalendarDays, CheckCircle2, ClipboardList, Clock, UserRound } from "lucide-react"
import { useSession } from "../../hooks/useSession"
import { apiDoctorToday, apiGetDoctor, ApiError } from "../../lib/api"
import type { DoctorDetail, TodaySlotQueue } from "../../lib/api"
import { formatTimeRange } from "../../lib/clinicDate"
import { formatPaise } from "../../lib/money"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * §28's landing tab (Day 31): the doctor's own row, the §5.2 states that matter
 * day to day, and a one-glance summary of today's schedule. The queue itself
 * stays on its own read-only tab; this page only repeats counts so the two
 * cannot disagree.
 */
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{data.fullName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your day, your availability and your listing.</p>
      </div>

      <StatusBanner doctor={data} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Windows today" value={String(windows.length)} icon={<CalendarDays className="size-4" />} />
        <StatCard label="Booked today" value={String(booked)} icon={<ClipboardList className="size-4" />} />
        <StatCard
          label="Up next"
          value={next === null ? "—" : formatTimeRange(next.slot.startTime, next.slot.endTime)}
          icon={<Clock className="size-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Today's schedule</CardTitle>
          <CardDescription>{today.data.date} — your windows for today.</CardDescription>
        </CardHeader>
        <CardContent>
          {windows.length === 0 ? (
            <EmptyState
              title="No window today"
              description="Your weekly template has no session for today. You can add one on the Schedule tab."
            >
              <Button asChild size="sm">
                <Link to="/doctor/schedule">Open schedule</Link>
              </Button>
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {windows.map((slot) => (
                <li
                  key={slot.slotId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
                >
                  <div>
                    <p className="font-medium">{formatTimeRange(slot.startTime, slot.endTime)}</p>
                    <p className="text-sm text-muted-foreground">
                      {slot.queue.length} booking{slot.queue.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link to="/doctor/queue">View queue</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your listing</CardTitle>
            <CardDescription>The details patients see.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Specialization" value={data.specialization ?? "—"} />
            <Row label="Qualification" value={data.qualification ?? "—"} />
            <Row
              label="Consultation fee"
              value={data.consultationFee !== null ? formatPaise(data.consultationFee, "INR") : "Set by the clinic"}
            />
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link to="/doctor/profile">Edit profile</Link>
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <QuickLink to="/doctor/queue" icon={<ClipboardList className="size-4" />} title="Live queue" description="Today's patients, read-only." />
          <QuickLink to="/doctor/schedule" icon={<CalendarDays className="size-4" />} title="Schedule" description="Weekly windows and time off." />
          <QuickLink to="/doctor/profile" icon={<UserRound className="size-4" />} title="Profile" description="Your public listing details." />
        </div>
      </div>
    </div>
  )
}

function nextUp(slots: readonly TodaySlotQueue[]): { slot: TodaySlotQueue } | null {
  for (const slot of slots) {
    if (slot.queue.some((entry) => entry.upNext)) return { slot }
  }
  return null
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

function QuickLink({
  to,
  icon,
  title,
  description,
}: {
  to: string
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <Link
      to={to}
      className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-2 font-medium">
        {icon}
        {title}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </Link>
  )
}

/**
 * §5.2's states, rendered as one honest banner. PENDING_VERIFICATION is the one
 * a doctor acts on themselves — it is the §5.2 "credentials changed" state that
 * §26 hides from the public list, so the dashboard is where it must be loud.
 */
function StatusBanner({ doctor }: { doctor: DoctorDetail }) {
  if (doctor.suspendedAt) {
    return (
      <Alert variant="destructive">
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
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Awaiting re-verification</AlertTitle>
        <AlertDescription>
          You changed a credential detail. Your listing is hidden from the public site until the clinic re-verifies
          you (§5.2).
        </AlertDescription>
      </Alert>
    )
  }
  if (doctor.verificationStatus === "REJECTED") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Verification rejected</AlertTitle>
        <AlertDescription>Speak to the clinic about the details that need correcting.</AlertDescription>
      </Alert>
    )
  }
  if (doctor.verificationStatus === "ARCHIVED") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Listing archived</AlertTitle>
        <AlertDescription>Your listing is no longer active.</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert>
      <CheckCircle2 />
      <AlertTitle>{doctor.isBookable ? "Verified and bookable" : "Awaiting verification"}</AlertTitle>
      <AlertDescription>
        {doctor.isBookable
          ? "You appear in the public directory."
          : "Your profile is awaiting clinic verification."}
      </AlertDescription>
    </Alert>
  )
}
