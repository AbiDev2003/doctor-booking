import { useEffect, useState } from "react"
import type { UseFormRegisterReturn } from "react-hook-form"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2 } from "lucide-react"
import { doctorProfileSchema, type DoctorProfileInputShape } from "@shared/doctors"
import { useSession } from "../../hooks/useSession"
import { apiGetDoctor, apiUpdateDoctor, ApiError } from "../../lib/api"
import { applyApiErrors } from "../../lib/formErrors"
import { PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * §5.2's self-edit (Day 31): the descriptive fields plus the credentials the
 * clinic verifies. The server owns the rules — a credential edit forces
 * PENDING_VERIFICATION (hidden from the public list until re-verified), a
 * descriptive-only edit changes nothing, and the fee is absent here because a
 * doctor may not set their own price (the service 403s; the form simply never
 * offers the field). Everything the page shows about status comes from the
 * UPDATE response, never from local imagination.
 */
const INITIAL: DoctorProfileInputShape = {
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

  const [formError, setFormError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DoctorProfileInputShape>({
    resolver: zodResolver(doctorProfileSchema),
    defaultValues: INITIAL,
  })

  useEffect(() => {
    if (doctor.data === undefined) return
    reset({
      fullName: doctor.data.fullName,
      qualification: doctor.data.qualification ?? "",
      licenseNumber: doctor.data.licenseNumber ?? "",
      experience: doctor.data.experience ?? "",
      clinicAssociation: doctor.data.clinicAssociation ?? "",
      specialization: doctor.data.specialization ?? "",
    })
  }, [doctor.data, reset])

  const mutation = useMutation({
    mutationFn: (values: DoctorProfileInputShape) => apiUpdateDoctor(user!.id, values),
    onSuccess: (result) => {
      setBanner(
        result.verificationStatus === "PENDING_VERIFICATION"
          ? "A credential changed. Your listing is hidden from the public site until the clinic re-verifies you (§5.2)."
          : "Profile updated.",
      )
      setFormError(null)
      // The public directory (and the Overview tab) reads this same row; a
      // changed credential can silently unmount a doctor from §26.
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] })
      void queryClient.invalidateQueries({ queryKey: ["admin"] })
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

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    setBanner(null)
    try {
      await mutation.mutateAsync(values)
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

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
          <TextInput
            label="Full name"
            name="fullName"
            error={errors.fullName?.message}
            registration={register("fullName")}
          />
          <TextInput
            label="Specialization"
            name="specialization"
            error={errors.specialization?.message}
            registration={register("specialization")}
          />
          <TextInput
            label="Experience"
            name="experience"
            error={errors.experience?.message}
            registration={register("experience")}
          />
          <TextInput
            label="Practice / clinic association"
            name="clinicAssociation"
            error={errors.clinicAssociation?.message}
            registration={register("clinicAssociation")}
          />
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border bg-card p-6">
          <legend className="px-1 text-sm font-semibold">Credentials — verified on the public listing</legend>
          <p className="text-sm text-muted-foreground">Editing a credential puts your listing back into re-verification.</p>
          <TextInput
            label="Qualification"
            name="qualification"
            error={errors.qualification?.message}
            registration={register("qualification")}
          />
          <TextInput
            label="License number"
            name="licenseNumber"
            error={errors.licenseNumber?.message}
            registration={register("licenseNumber")}
          />
        </fieldset>

        {formError !== null && (
          <Alert variant="destructive">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={isSubmitting || mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </div>
  )
}

function TextInput({
  label,
  name,
  error,
  registration,
}: {
  label: string
  name: keyof DoctorProfileInputShape
  error: string | undefined
  registration: UseFormRegisterReturn
}) {
  const errorId = `${name}-error`
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type="text"
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? errorId : undefined}
        {...registration}
      />
      {error !== undefined && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
