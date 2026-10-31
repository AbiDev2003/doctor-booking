import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Search, UserRound } from "lucide-react"
import { attachPatientEmailSchema } from "@shared/staff"
import { apiAttachPatientEmail, apiVisitHistory, ApiError } from "@/lib/api"
import type { DeskPatient, VisitHistory } from "@/lib/api"
import { formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { applyApiErrors } from "@/lib/formErrors"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

/**
 * §16's phone lookup (Day 32): one number → the patient on file, their
 * completed/no-show/upcoming counts, the doctors they have seen, and the
 * bookings the desk can still act on.
 *
 * The lookup is exact-match on the normalised phone, and the server owns the
 * normalization. An unknown number is a truthful "not found", not an error.
 */
export default function Patients() {
  const [params] = useSearchParams()
  const initialPhone = params.get("phone") ?? ""
  const [phone, setPhone] = useState(initialPhone)
  const [lookedUpPhone, setLookedUpPhone] = useState<string | null>(null)
  const autoSearched = useRef(false)

  const search = useMutation({
    mutationFn: (value: string) => apiVisitHistory(value).then((result) => result.history),
    onSuccess: (history) => {
      setLookedUpPhone(history.patient?.phone ?? phone.trim())
    },
  })

  useEffect(() => {
    if (autoSearched.current || initialPhone.trim() === "") return
    autoSearched.current = true
    search.mutate(initialPhone.trim())
  }, [initialPhone, search])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (phone.trim() !== "") search.mutate(phone.trim())
  }

  const history: VisitHistory | undefined = search.data

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Patient lookup</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Type the phone number the patient gave at booking. The desk sees the same record the clinic keeps.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="w-full max-w-sm space-y-2">
          <Label htmlFor="lookup-phone">Phone</Label>
          <Input
            id="lookup-phone"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            placeholder="98765 43210"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={phone.trim() === "" || search.isPending}>
          <Search className="size-4" />
          {search.isPending ? "Searching…" : "Search"}
        </Button>
      </form>

      {search.isPending && search.data === undefined && <PageLoading label="Looking up the patient…" />}

      {search.error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Lookup failed</AlertTitle>
          <AlertDescription>
            {search.error instanceof ApiError ? search.error.message : "Try again in a moment."}
          </AlertDescription>
        </Alert>
      )}

      {history !== undefined && !history.found && (
        <EmptyState
          title="No patient on file"
          description={`No appointments exist for ${lookedUpPhone ?? "that number"}. Create a walk-in from the Appointments tab.`}
        >
          <UserRound className="size-4" />
        </EmptyState>
      )}

      {history !== undefined && history.found && history.patient !== null && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{history.patient.fullName}</CardTitle>
                <div className="flex flex-wrap gap-2">
                  {history.returning && <Badge>Returning patient</Badge>}
                  {history.patient.isProvisional && <Badge variant="outline">Walk-in record</Badge>}
                  {history.patient.isDeactivated && <Badge variant="destructive">Deactivated</Badge>}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {history.patient.phone}
                {history.patient.email !== null ? ` · ${history.patient.email}` : ""} · On file since{" "}
                {formatSlotDate(history.patient.createdAt.slice(0, 10))}
              </p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Completed" value={history.completedCount} />
                <Stat label="No-shows" value={history.noShowCount} />
                <Stat label="Upcoming" value={history.upcomingCount} />
                <Stat label="Last visit" value={history.lastVisitDate ?? "—"} />
              </dl>
              {history.doctorsSeen.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Doctors seen</p>
                  <div className="flex flex-wrap gap-2">
                    {history.doctorsSeen.map((doctor) => (
                      <Badge key={doctor} variant="secondary">
                        {doctor}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {history.patient.isProvisional && (
            <AttachEmailCard
              key={history.patient.id}
              patient={history.patient}
              onAttached={() => search.mutate(history.patient?.phone ?? lookedUpPhone ?? "")}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Upcoming bookings</CardTitle>
            </CardHeader>
            <CardContent>
              {history.upcomingAppointments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No upcoming bookings for this patient.</p>
              ) : (
                <ol className="space-y-3">
                  {history.upcomingAppointments.map((appointment, index) => (
                    <li key={appointment.id}>
                      {index > 0 && <Separator className="mb-3" />}
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{appointment.doctorName}</span>
                            <AppointmentStatusBadge status={appointment.status} />
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {formatSlotDate(appointment.slotDate)} ·{" "}
                            {formatTimeRange(appointment.startTime, appointment.endTime)}
                          </p>
                          {appointment.payment.outstandingPaise > 0 && (
                            <p className="text-sm text-destructive">
                              Payment outstanding: {formatPaise(appointment.payment.outstandingPaise, "INR")}
                            </p>
                          )}
                        </div>
                        <AppointmentActions
                          appointment={appointment}
                          onChanged={() => {
                            if (lookedUpPhone !== null) search.mutate(lookedUpPhone)
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function AttachEmailCard({ patient, onAttached }: { patient: DeskPatient; onAttached: () => void }) {
  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>({
    resolver: zodResolver(attachPatientEmailSchema),
    defaultValues: { email: patient.email ?? "" },
  })

  const attach = useMutation({
    mutationFn: (email: string) => apiAttachPatientEmail(patient.id, email),
    onSuccess: (result) => {
      setNotice(result.message)
      setFormError(null)
      onAttached()
    },
    onError: (error) => {
      setNotice(null)
      setFormError(applyApiErrors(error, setError) ?? null)
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email on the walk-in record</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Attaching an address does not create a login. It gives the patient a contact on file and a future claim path.
        </p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={handleSubmit((values) => {
            setNotice(null)
            setFormError(null)
            attach.mutate(values.email)
          })}
          noValidate
        >
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="attach-email">Email</Label>
            <Input
              id="attach-email"
              type="email"
              autoComplete="off"
              aria-invalid={errors.email !== undefined}
              aria-describedby={errors.email !== undefined ? "attach-email-error" : undefined}
              {...register("email")}
            />
            {errors.email?.message !== undefined && (
              <p id="attach-email-error" className="text-xs text-destructive" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>
          <Button type="submit" disabled={isSubmitting || attach.isPending}>
            {attach.isPending ? "Attaching…" : patient.email === null ? "Attach email" : "Update email"}
          </Button>
        </form>
        {notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}
        {formError !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not attach the email</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  )
}
