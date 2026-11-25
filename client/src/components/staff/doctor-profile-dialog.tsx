import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { ImagePlus, Trash2 } from "lucide-react"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  apiDeleteDoctorProfileImage,
  apiUpdateDoctor,
  apiUploadDoctorProfileImage,
  ApiError,
  type DoctorDetail,
} from "@/lib/api"
import { applyApiErrors } from "@/lib/formErrors"

const schema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(200, "Full name is too long"),
  specialization: z.string().trim().max(300, "Too long"),
  qualification: z.string().trim().max(300, "Too long"),
  licenseNumber: z.string().trim().max(100, "Too long"),
  experience: z.string().trim().max(100, "Too long"),
  clinicAssociation: z.string().trim().max(300, "Too long"),
  consultationFeeRupees: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d+$/.test(v), "Enter a whole rupee amount"),
})

type FormValues = z.infer<typeof schema>

function toForm(doctor: DoctorDetail): FormValues {
  return {
    fullName: doctor.fullName ?? "",
    specialization: doctor.specialization ?? "",
    qualification: doctor.qualification ?? "",
    licenseNumber: doctor.licenseNumber ?? "",
    experience: doctor.experience ?? "",
    clinicAssociation: doctor.clinicAssociation ?? "",
    consultationFeeRupees:
      doctor.consultationFee !== null && doctor.consultationFee !== undefined
        ? String(Math.round(doctor.consultationFee / 100))
        : "",
  }
}

interface Props {
  doctor: DoctorDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DoctorProfileDialog({ doctor, open, onOpenChange }: Props) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: "",
      specialization: "",
      qualification: "",
      licenseNumber: "",
      experience: "",
      clinicAssociation: "",
      consultationFeeRupees: "",
    },
  })

  useEffect(() => {
    if (doctor && open) {
      reset(toForm(doctor))
      setFormError(null)
      setBanner(null)
      setImageError(null)
      setCurrentImageUrl(doctor.profileImageUrl ?? null)
    }
  }, [doctor, open, reset])

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin"] })
    await queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
    await queryClient.invalidateQueries({ queryKey: ["public", "doctor"] })
    if (doctor) await queryClient.invalidateQueries({ queryKey: ["doctor", doctor.id] })
  }

  const saveMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!doctor) throw new Error("No doctor selected")
      const patch: Record<string, unknown> = {}
      const current = toForm(doctor)

      const textKeys: (keyof FormValues)[] = [
        "fullName",
        "specialization",
        "qualification",
        "licenseNumber",
        "experience",
        "clinicAssociation",
      ]
      for (const key of textKeys) {
        const next = values[key].trim()
        const prev = current[key].trim()
        if (next !== prev) {
          if (next === "" && key !== "fullName") continue // don't clear to empty via this form
          patch[key] = next
        }
      }

      if (values.consultationFeeRupees.trim() !== current.consultationFeeRupees.trim()) {
        if (values.consultationFeeRupees.trim() === "") {
          // no-op: don't clear fee
        } else {
          patch.consultationFee = Number(values.consultationFeeRupees) * 100
        }
      }

      if (Object.keys(patch).length === 0) {
        return { verificationStatus: doctor.verificationStatus, changed: false as const }
      }
      const result = await apiUpdateDoctor(doctor.id, patch as any)
      return { ...result, changed: true as const }
    },
    onSuccess: async (result) => {
      setFormError(null)
      if (result.changed) {
        setBanner(
          result.verificationStatus === "PENDING_VERIFICATION"
            ? "Profile updated. Credential changes may require re-verification."
            : "Profile updated.",
        )
        await invalidate()
      } else {
        setBanner("No profile field changes to save.")
      }
    },
    onError: (err) => {
      const msg = applyApiErrors(err, setError)
      setFormError(msg ?? (err instanceof ApiError ? err.message : "Failed to update profile."))
    },
  })

  const uploadImage = useMutation({
    mutationFn: (file: File) => {
      if (!doctor) throw new Error("No doctor selected")
      return apiUploadDoctorProfileImage(doctor.id, file)
    },
    onSuccess: async (result) => {
      setImageError(null)
      setCurrentImageUrl(result.profileImageUrl)
      setBanner("Profile photo updated.")
      await invalidate()
    },
    onError: (err) => {
      setImageError(err instanceof ApiError ? err.message : "Failed to upload profile photo.")
    },
  })

  const removeImage = useMutation({
    mutationFn: () => {
      if (!doctor) throw new Error("No doctor selected")
      return apiDeleteDoctorProfileImage(doctor.id)
    },
    onSuccess: async () => {
      setImageError(null)
      setCurrentImageUrl(null)
      setBanner("Profile photo removed.")
      await invalidate()
    },
    onError: (err) => {
      setImageError(err instanceof ApiError ? err.message : "Failed to remove profile photo.")
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setBanner(null)
    setFormError(null)
    await saveMutation.mutateAsync(values).catch(() => undefined)
  })

  const busy = isSubmitting || uploadImage.isPending || removeImage.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{doctor ? `Edit profile — ${doctor.fullName}` : "Edit doctor profile"}</DialogTitle>
          <DialogDescription>
            Update profile details and photo. Credential changes may move verification to pending.
          </DialogDescription>
        </DialogHeader>

        {doctor && (
          <div className="space-y-5">
            <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <DoctorAvatar src={currentImageUrl} name={doctor.fullName} className="size-16 text-lg" />
                <div>
                  <p className="text-sm font-medium">Profile photo</p>
                  <p className="text-xs text-muted-foreground">JPG, PNG or WebP. Max 2 MB. Default avatar shown when empty.</p>
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
                    setImageError(null)
                    setBanner(null)
                    uploadImage.mutate(file)
                    e.currentTarget.value = ""
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                  <ImagePlus />
                  {uploadImage.isPending ? "Uploading…" : currentImageUrl ? "Change photo" : "Upload photo"}
                </Button>
                {currentImageUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setImageError(null)
                      setBanner(null)
                      removeImage.mutate()
                    }}
                    disabled={busy}
                  >
                    <Trash2 />
                    {removeImage.isPending ? "Removing…" : "Remove"}
                  </Button>
                )}
              </div>
            </div>

            {imageError && <p className="text-sm text-destructive" role="alert">{imageError}</p>}
            {banner && (
              <Alert>
                <AlertTitle>Status</AlertTitle>
                <AlertDescription>{banner}</AlertDescription>
              </Alert>
            )}
            {formError && (
              <Alert variant="destructive">
                <AlertTitle>Could not save</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <form id="doctor-profile-edit-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" error={errors.fullName?.message}>
                <Input {...register("fullName")} />
              </Field>
              <Field label="Specialization" error={errors.specialization?.message}>
                <Input {...register("specialization")} />
              </Field>
              <Field label="Qualification" error={errors.qualification?.message}>
                <Input {...register("qualification")} />
              </Field>
              <Field label="License number" error={errors.licenseNumber?.message}>
                <Input {...register("licenseNumber")} />
              </Field>
              <Field label="Experience" error={errors.experience?.message}>
                <Input {...register("experience")} />
              </Field>
              <Field label="Clinic association" error={errors.clinicAssociation?.message}>
                <Input {...register("clinicAssociation")} />
              </Field>
              <Field label="Consultation fee (₹)" error={errors.consultationFeeRupees?.message}>
                <Input {...register("consultationFeeRupees")} inputMode="numeric" />
              </Field>
            </form>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button type="submit" form="doctor-profile-edit-form" disabled={busy || !doctor}>
            {isSubmitting ? "Saving…" : "Save profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
