import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { clinicSettingsPatchSchema } from "@shared/clinics"
import { apiClinicSettings, apiUpdateClinicSettings, ApiError } from "@/lib/api"
import type { ClinicSettingsPatch } from "@/lib/api"
import { applyApiErrors } from "@/lib/formErrors"
import { PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const FIELDS = [
  { key: "bookingHorizonDays", label: "Booking horizon (days)", min: 1, max: 365 },
  { key: "cancelCutoffMinutes", label: "Cancel cutoff (minutes)", min: 0, max: 10080 },
  { key: "holdDurationMinutes", label: "Seat hold (minutes)", min: 1, max: 120 },
  { key: "minLeadMinutes", label: "Minimum lead (minutes)", min: 0, max: 10080 },
  { key: "reminderLeadMinutes", label: "Reminder lead (minutes)", min: 0, max: 10080 },
  { key: "maxActiveBookingsPerPatient", label: "Max active bookings / patient", min: 1, max: 100 },
  { key: "unclosedBookingReminderMinutes", label: "Unclosed follow-up (minutes after slot end)", min: 1, max: 10080 },
] as const

export default function Settings() {
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ClinicSettingsPatch>({
    resolver: zodResolver(clinicSettingsPatchSchema),
    defaultValues: {},
  })

  const settings = useQuery({ queryKey: ["admin", "clinic-settings"], queryFn: ({ signal }) => apiClinicSettings(signal) })

  const save = useMutation({
    mutationFn: (patch: ClinicSettingsPatch) => apiUpdateClinicSettings(patch),
    onSuccess: (result) => {
      setNotice(result.message)
      setFormError(null)
      reset({})
      void queryClient.invalidateQueries({ queryKey: ["admin", "clinic-settings"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "clinic"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError) ?? null)
    },
  })

  if (settings.isPending) return <PageLoading label="Loading settings…" />
  if (settings.isError) {
    return (
      <PageError
        title="Settings could not be loaded"
        message={settings.error instanceof ApiError ? settings.error.message : undefined}
        onRetry={() => void settings.refetch()}
      />
    )
  }

  const current = settings.data.settings

  const submit = handleSubmit((values) => {
    setNotice(null)
    setFormError(null)
    const patch: ClinicSettingsPatch = {}
    for (const field of FIELDS) {
      const value = values[field.key]
      if (value !== undefined && value !== current[field.key]) patch[field.key] = value
    }
    if (Object.keys(patch).length === 0) {
      setNotice("No changes to save.")
      return
    }
    save.mutate(patch)
  })

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Clinic settings</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Scheduling tunables apply clinic-wide. Name, timezone, currency, and default fee are seed-owned.
        </p>
      </section>

      {notice !== null && (
        <Alert className="rounded-2xl border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {formError !== null && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertTitle>Could not save settings</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Clinic</CardTitle>
          <CardDescription>Read-only clinic identity values.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3">
              <dt className="text-slate-500">Name</dt>
              <dd className="mt-1 font-medium text-slate-950">{current.name}</dd>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3">
              <dt className="text-slate-500">Timezone</dt>
              <dd className="mt-1 font-medium text-slate-950">{current.timezone}</dd>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3">
              <dt className="text-slate-500">Currency</dt>
              <dd className="mt-1 font-medium text-slate-950">{current.currency}</dd>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3">
              <dt className="text-slate-500">Default consultation fee</dt>
              <dd className="mt-1 font-medium text-slate-950">{current.defaultConsultationFee}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Scheduling tunables</CardTitle>
          <CardDescription>Leave a field blank to keep its current value.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {FIELDS.map((field) => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  <Input
                    id={field.key}
                    type="number"
                    min={field.min}
                    max={field.max}
                    className="bg-white"
                    placeholder={String(current[field.key])}
                    aria-invalid={errors[field.key] !== undefined}
                    aria-describedby={errors[field.key] !== undefined ? `${field.key}-error` : undefined}
                    {...register(field.key, {
                      setValueAs: (value: string) => (value.trim() === "" ? undefined : Number(value)),
                    })}
                  />
                  {errors[field.key]?.message !== undefined && (
                    <p id={`${field.key}-error`} className="text-sm text-destructive" role="alert">
                      {errors[field.key]?.message}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {errors.root?.message !== undefined && (
              <p className="text-sm text-destructive" role="alert">
                {errors.root.message}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={isSubmitting || save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
              <Button type="button" variant="outline" className="bg-white" onClick={() => reset({})}>
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
