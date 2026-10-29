import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2 } from "lucide-react"
import { useSession } from "../../hooks/useSession"
import { apiGetDoctor, apiUpdateDoctor, ApiError } from "../../lib/api"
import { PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type FieldErrors = Record<string, string>

/**
 * §5.2's self-edit (Day 31): the descriptive fields plus the credentials the
 * clinic verifies. The server owns the rules — a credential edit forces
 * PENDING_VERIFICATION (hidden from the public list until re-verified), a
 * descriptive-only edit changes nothing, and the fee is absent here because a
 * doctor may not set their own price (the service 403s; the form simply never
 * offers the field). Everything the page shows about status comes from the
 * UPDATE response, never from local imagination.
 */
const INITIAL = {
  fullName: "",
  qualification: "",
  licenseNumber: "",
  experience: "",
  clinicAssociation: "",
  specialization: "",
}

export default function ProfileForm() {
  const { user } = useSession()
  const queryClient = useQueryClient()
  const doctor = useQuery({
    queryKey: ["doctor", user?.id],
    queryFn: () => apiGetDoctor(user!.id).then((r) => r.doctor),
    enabled: user !== null,
  })

  const [values, setValues] = useState(INITIAL)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  // Seed the form once the row arrives, and only into an untouched form.
  if (doctor.data !== undefined && loadedFor !== doctor.data.id) {
    setLoadedFor(doctor.data.id)
    setValues({
      fullName: doctor.data.fullName,
      qualification: doctor.data.qualification ?? "",
      licenseNumber: doctor.data.licenseNumber ?? "",
      experience: doctor.data.experience ?? "",
      clinicAssociation: doctor.data.clinicAssociation ?? "",
      specialization: doctor.data.specialization ?? "",
    })
  }

  const mutation = useMutation({
    mutationFn: () => apiUpdateDoctor(user!.id, values),
    onSuccess: (result) => {
      setBanner(
        result.verificationStatus === "PENDING_VERIFICATION"
          ? "A credential changed. Your listing is hidden from the public site until the clinic re-verifies you (§5.2)."
          : "Profile updated.",
      )
      setFormError(null)
      setFieldErrors({})
      // The public directory (and the Overview tab) reads this same row; a
      // changed credential can silently unmount a doctor from §26.
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] })
    },
  })

  if (doctor.isPending || !user) return <PageLoading label="Loading your profile…" />

  if (doctor.isError || doctor.data === undefined) {
    return (
      <PageError
        title="Your profile could not be loaded"
        message={doctor.error instanceof ApiError ? doctor.error.message : undefined}
        onRetry={() => void doctor.refetch()}
      />
    )
  }

  function update(name: keyof typeof INITIAL, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }))
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    setBanner(null)
    setFieldErrors({})
    try {
      await mutation.mutateAsync()
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField())
        if (err.fields.length === 0) setFormError(err.message)
      } else {
        setFormError("Something went wrong. Please try again.")
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Your profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Verified as a doctor at this clinic.</p>
      </div>

      {banner !== null && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <fieldset className="space-y-4 rounded-xl border bg-card p-6">
          <legend className="px-1 text-sm font-semibold">Descriptive details</legend>
          <TextInput label="Full name" name="fullName" value={values.fullName} error={fieldErrors.fullName} onChange={update} />
          <TextInput label="Specialization" name="specialization" value={values.specialization} error={fieldErrors.specialization} onChange={update} />
          <TextInput label="Experience" name="experience" value={values.experience} error={fieldErrors.experience} onChange={update} />
          <TextInput
            label="Practice / clinic association"
            name="clinicAssociation"
            value={values.clinicAssociation}
            error={fieldErrors.clinicAssociation}
            onChange={update}
          />
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border bg-card p-6">
          <legend className="px-1 text-sm font-semibold">Credentials — verified on the public listing</legend>
          <p className="text-sm text-muted-foreground">Editing a credential puts your listing back into re-verification.</p>
          <TextInput label="Qualification" name="qualification" value={values.qualification} error={fieldErrors.qualification} onChange={update} />
          <TextInput label="License number" name="licenseNumber" value={values.licenseNumber} error={fieldErrors.licenseNumber} onChange={update} />
        </fieldset>

        {formError !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </div>
  )
}

function TextInput({
  label,
  name,
  value,
  error,
  onChange,
}: {
  label: string
  name: keyof typeof INITIAL
  value: string
  error?: string | undefined
  onChange: (name: keyof typeof INITIAL, value: string) => void
}) {
  const errorId = `${name}-error`
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="text"
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        onChange={(e) => onChange(name, e.target.value)}
      />
      {error !== undefined && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
