import { useEffect, useRef, useState } from "react"
import type { UseFormRegisterReturn } from "react-hook-form"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, ImagePlus, Trash2, UserRound } from "lucide-react"
import { doctorProfileSchema, type DoctorProfileInputShape } from "@shared/doctors"
import { useSession } from "../../hooks/useSession"
import {
  apiDeleteDoctorProfileImage,
  apiGetDoctor,
  apiUpdateDoctor,
  apiUploadDoctorProfileImage,
  ApiError,
} from "../../lib/api"
import { applyApiErrors } from "../../lib/formErrors"
import { PageError, PageLoading } from "@/components/async-state"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageMessage, setImageMessage] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (values: DoctorProfileInputShape) => apiUpdateDoctor(user!.id, values),
    onSuccess: (result) => {
      setBanner(
        result.credentialChangeSubmitted
          ? "Credential changes sent to the clinic for approval. Your current public profile stays live and bookable until they are approved."
          : result.verificationStatus === "PENDING_VERIFICATION"
            ? "A credential changed. Your listing is hidden from the public site until the clinic re-verifies you."
            : "Profile updated successfully.",
      )
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] })
      void queryClient.invalidateQueries({ queryKey: ["admin"] })
    },
  })

  const uploadImage = useMutation({
    mutationFn: (file: File) => apiUploadDoctorProfileImage(user!.id, file),
    onSuccess: () => {
      setImageError(null)
      setImageMessage("Profile photo updated.")
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
    },
    onError: (err) => {
      setImageMessage(null)
      setImageError(err instanceof ApiError ? err.message : "Failed to upload profile photo.")
    },
  })

  const removeImage = useMutation({
    mutationFn: () => apiDeleteDoctorProfileImage(user!.id),
    onSuccess: () => {
      setImageError(null)
      setImageMessage("Profile photo removed.")
      void queryClient.invalidateQueries({ queryKey: ["doctor", user!.id] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
    },
    onError: (err) => {
      setImageMessage(null)
      setImageError(err instanceof ApiError ? err.message : "Failed to remove profile photo.")
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
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Profile</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Your profile</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Manage your public listing details and credentials. Credential changes require clinic re-verification.
        </p>
      </section>

      {banner !== null && (
        <Alert className="rounded-2xl border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
          <CheckCircle2 />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Profile photo</CardTitle>
          <CardDescription>JPG, PNG, or WebP. Max 2 MB. A default avatar is shown when no photo is uploaded.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <DoctorAvatar src={doctor.data.profileImageUrl} name={doctor.data.fullName} className="size-20 text-xl ring-4 ring-slate-50" />
              <div>
                <p className="font-medium text-slate-900">{doctor.data.fullName}</p>
                <p className="text-sm text-slate-500">{doctor.data.specialization || "Doctor profile"}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setImageMessage(null)
                  setImageError(null)
                  uploadImage.mutate(file)
                  e.currentTarget.value = ""
                }}
              />
              <Button type="button" variant="outline" className="bg-white" onClick={() => fileInputRef.current?.click()} disabled={uploadImage.isPending || removeImage.isPending}>
                <ImagePlus className="size-4" aria-hidden="true" />
                {uploadImage.isPending ? "Uploading…" : doctor.data.profileImageUrl ? "Change photo" : "Upload photo"}
              </Button>
              {doctor.data.profileImageUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                  onClick={() => {
                    setImageMessage(null)
                    setImageError(null)
                    removeImage.mutate()
                  }}
                  disabled={uploadImage.isPending || removeImage.isPending}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {removeImage.isPending ? "Removing…" : "Remove"}
                </Button>
              )}
            </div>
          </div>
          {imageMessage && <p className="mt-4 text-sm text-green-700">{imageMessage}</p>}
          {imageError && <p className="mt-4 text-sm text-destructive" role="alert">{imageError}</p>}
        </CardContent>
      </Card>

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="inline-flex size-10 items-center justify-center rounded-xl bg-blue-50 text-primary ring-1 ring-blue-100">
                <UserRound className="size-5" aria-hidden="true" />
              </div>
              <div>
                <CardTitle className="text-xl text-slate-950">Descriptive details</CardTitle>
                <CardDescription>Information shown on your public profile.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Full name" name="fullName" error={errors.fullName?.message} registration={register("fullName")} />
            <TextInput label="Specialization" name="specialization" error={errors.specialization?.message} registration={register("specialization")} />
            <TextInput label="Experience" name="experience" error={errors.experience?.message} registration={register("experience")} />
            <TextInput label="Practice / clinic association" name="clinicAssociation" error={errors.clinicAssociation?.message} registration={register("clinicAssociation")} />
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">Credentials</CardTitle>
            <CardDescription>Verified on the public listing. Edits are sent to the clinic for approval; your current profile stays live and bookable until they are approved.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Qualification" name="qualification" error={errors.qualification?.message} registration={register("qualification")} />
            <TextInput label="License number" name="licenseNumber" error={errors.licenseNumber?.message} registration={register("licenseNumber")} />
          </CardContent>
        </Card>

        {formError !== null && (
          <Alert variant="destructive" className="rounded-2xl">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
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
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type="text"
        className="bg-white"
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
