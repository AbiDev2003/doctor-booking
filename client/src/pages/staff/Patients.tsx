import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CalendarDays, Search, UserRound } from "lucide-react"
import { attachPatientEmailSchema } from "@shared/staff"
import { apiAttachPatientEmail, apiPatientSlotView, apiPublicClinic, apiVisitHistory, ApiError } from "@/lib/api"
import type { DeskPatient, SlotViewAppointment, SlotViewSlot, VisitHistory } from "@/lib/api"
import { addDays, clinicToday, formatSlotDate, formatTimeRange } from "@/lib/clinicDate"
import { applyApiErrors } from "@/lib/formErrors"
import { formatPaise } from "@/lib/money"
import { AppointmentActions } from "@/components/staff/appointment-actions"
import { AppointmentStatusBadge } from "@/components/appointment-status-badge"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

type Tab = "slots" | "lookup"

/**
 * §16's two ways into a patient: the day grouped by doctor → slot → patient
 * (the front desk's default), and the phone-keyed returning-patient lookup.
 *
 * The slot view opens on the clinic's own today and can be searched with the
 * same phone-prefix / fuzzy-name input the admin directory uses. The phone
 * lookup stays exact on the normalised number because its job is one record,
 * not a list.
 */
export default function Patients() {
  const [params] = useSearchParams()
  const initialPhone = params.get("phone") ?? ""
  const [tab, setTab] = useState<Tab>(() => (params.get("tab") === "lookup" ? "lookup" : "slots"))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Patients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          See the day slot by slot, or look up a returning patient by phone. The desk sees the same record the clinic
          keeps.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={tab === "slots" ? "default" : "outline"} size="sm" onClick={() => setTab("slots")}>
          By slot
        </Button>
        <Button variant={tab === "lookup" ? "default" : "outline"} size="sm" onClick={() => setTab("lookup")}>
          Phone lookup
        </Button>
      </div>

      {tab === "slots" ? <SlotView /> : <PhoneLookup initialPhone={initialPhone} />}
    </div>
  )
}

function SlotView() {
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: () => apiPublicClinic() })
  const timezone = clinic.data?.clinic.timezone

  const [date, setDate] = useState("")
  const [search, setSearch] = useState("")
  const [submitted, setSubmitted] = useState("")

  // An empty `date` means "follow the clinic's today"; the button and the
  // picker both write a concrete date once the desk steps away from today.
  const selectedDate = date !== "" ? date : timezone !== undefined ? clinicToday(timezone) : ""

  const view = useQuery({
    queryKey: ["staff", "patient-slot-view", selectedDate, submitted],
    queryFn: ({ signal }) =>
      apiPatientSlotView(
        {
          date: selectedDate,
          ...(submitted !== "" && { search: submitted }),
          limit: 100,
        },
        signal,
      ),
    enabled: selectedDate !== "",
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(search.trim())
  }

  function today() {
    setDate(timezone !== undefined ? clinicToday(timezone) : "")
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="slot-date">Clinic date</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="slot-date"
              type="date"
              className="w-44"
              value={selectedDate}
              disabled={selectedDate === ""}
              onChange={(event) => setDate(event.target.value)}
            />
            <Button type="button" variant="outline" size="sm" onClick={today} disabled={selectedDate === ""}>
              Today
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={selectedDate === ""}
              onClick={() => setDate(addDays(selectedDate, -1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={selectedDate === ""}
              onClick={() => setDate(addDays(selectedDate, 1))}
            >
              Next
            </Button>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-1 flex-wrap items-end gap-2">
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="slot-search">Search patient</Label>
            <Input
              id="slot-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Phone or name"
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={view.isFetching}>
            <Search className="size-4" />
            {view.isFetching ? "Searching…" : "Search"}
          </Button>
          {submitted !== "" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch("")
                setSubmitted("")
              }}
            >
              Clear
            </Button>
          )}
        </form>
      </div>

      {view.isPending && <PageLoading label="Loading the day…" />}
      {view.isError && (
        <PageError
          title="The day could not be loaded"
          message={view.error instanceof ApiError ? view.error.message : undefined}
          onRetry={() => void view.refetch()}
        />
      )}

      {view.data !== undefined && (
        <>
          <p className="text-sm text-muted-foreground">
            {submitted === ""
              ? `${view.data.totalAppointments} booked appointment${
                  view.data.totalAppointments === 1 ? "" : "s"
                } on ${formatSlotDate(view.data.date)}.`
              : `${view.data.totalAppointments} match${view.data.totalAppointments === 1 ? "" : "es"} for “${submitted}” on ${formatSlotDate(
                  view.data.date,
                )}.`}
          </p>

          {view.data.doctors.length === 0 && (
            <EmptyState
              title={submitted === "" ? "No slots on this day" : "No matching patients"}
              description={
                submitted === ""
                  ? "No doctor has slots for this clinic date."
                  : "No patient on this day matches that phone prefix or name."
              }
            >
              <CalendarDays className="size-4" />
            </EmptyState>
          )}

          {view.data.doctors.map((doctor) => (
            <Card key={doctor.doctorId}>
              <CardHeader>
                <CardTitle>{doctor.doctorName}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {doctor.slots.length} slot{doctor.slots.length === 1 ? "" : "s"} shown
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {doctor.slots.map((slot) => (
                  <SlotBlock key={slot.slotId} slot={slot} />
                ))}
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  )
}

function SlotBlock({ slot }: { slot: SlotViewSlot }) {
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{formatTimeRange(slot.startTime, slot.endTime)}</span>
          <Badge variant="outline">
            {slot.bookedCount}/{slot.maxPatients} booked
          </Badge>
          {slot.isDisabled && <Badge variant="destructive">disabled</Badge>}
        </div>
      </div>

      {slot.appointments.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No bookings in this slot.</p>
      ) : (
        <ul className="divide-y">
          {slot.appointments.map((appointment) => (
            <SlotAppointmentRow key={appointment.id} appointment={appointment} />
          ))}
        </ul>
      )}
    </div>
  )
}

function SlotAppointmentRow({ appointment }: { appointment: SlotViewAppointment }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{appointment.patientName}</span>
          <AppointmentStatusBadge status={appointment.status} />
          {appointment.isProvisional && <Badge variant="outline">walk-in</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {appointment.phone}
          {appointment.email !== null ? ` · ${appointment.email}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          Fee {formatPaise(appointment.feeAmount, "INR")}
          {appointment.payment.outstandingPaise > 0
            ? ` · ${formatPaise(appointment.payment.outstandingPaise, "INR")} outstanding`
            : appointment.payment.paidPaise > 0
              ? " · paid"
              : ""}
        </p>
      </div>
    </li>
  )
}

function PhoneLookup({ initialPhone }: { initialPhone: string }) {
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
