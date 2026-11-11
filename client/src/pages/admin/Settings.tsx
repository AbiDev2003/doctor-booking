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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

const FIELDS = [
  { key: "bookingHorizonDays", label: "Booking horizon (days)", min: 1, max: 365 },
  { key: "cancelCutoffMinutes", label: "Cancel cutoff (minutes)", min: 0, max: 10080 },
  { key: "holdDurationMinutes", label: "Seat hold (minutes)", min: 1, max: 120 },
  { key: "minLeadMinutes", label: "Minimum lead (minutes)", min: 0, max: 10080 },
  { key: "reminderLeadMinutes", label: "Reminder lead (minutes)", min: 0, max: 10080 },
  { key: "maxActiveBookingsPerPatient", label: "Max active bookings / patient", min: 1, max: 100 },
] as const

/** §29's settings tab (Day 33): the six scheduling tunables. */
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Scheduling tunables apply clinic-wide. Name, timezone, currency and default fee are seed-owned.
        </p>
      </div>

      {notice !== null && (
        <Alert>
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {formError !== null && (
        <Alert variant="destructive">
          <AlertTitle>Could not save settings</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Clinic</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">{current.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Timezone</dt>
              <dd className="font-medium">{current.timezone}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Currency</dt>
              <dd className="font-medium">{current.currency}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Default consultation fee</dt>
              <dd className="font-medium">{current.defaultConsultationFee}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scheduling tunables</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <label key={field.key} className="space-y-1 text-sm">
                  <span className="text-muted-foreground">{field.label}</span>
                  <Input
                    type="number"
                    min={field.min}
                    max={field.max}
                    placeholder={String(current[field.key])}
                    aria-invalid={errors[field.key] !== undefined}
                    aria-describedby={errors[field.key] !== undefined ? `${field.key}-error` : undefined}
                    {...register(field.key, {
                      setValueAs: (value: string) => (value.trim() === "" ? undefined : Number(value)),
                    })}
                  />
                  {errors[field.key]?.message !== undefined && (
                    <p id={`${field.key}-error`} className="text-xs text-destructive" role="alert">
                      {errors[field.key]?.message}
                    </p>
                  )}
                </label>
              ))}
            </div>
            {errors.root?.message !== undefined && (
              <p className="text-sm text-destructive" role="alert">
                {errors.root.message}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting || save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => reset({})}>
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

