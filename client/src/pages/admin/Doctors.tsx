import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { inviteDoctorSchema, type InviteDoctorInputShape } from "@shared/doctors"
import { DoctorAvatar } from "@/components/doctor-avatar"
import { DoctorProfileDialog } from "@/components/staff/doctor-profile-dialog"
import {
  apiArchiveDoctor,
  apiDoctorInvitations,
  apiInviteDoctor,
  apiRejectDoctor,
  apiResendDoctorInvitation,
  apiRevokeDoctorInvitation,
  apiStaffDoctors,
  apiSuspendDoctor,
  apiUnarchiveDoctor,
  apiUnsuspendDoctor,
  apiVerifyDoctor,
  ApiError,
} from "@/lib/api"
import type { DoctorDetail } from "@/lib/api"
import { applyApiErrors } from "@/lib/formErrors"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { PendingInvitationsCard } from "@/components/staff/pending-invitations"
import { ReasonDialog } from "@/components/staff/reason-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

type ReasonAction = "reject" | "suspend" | "archive" | "unarchive"

const REASON_COPY: Record<ReasonAction, { title: string; description: string; confirm: string }> = {
  reject: {
    title: "Reject doctor verification",
    description: "The doctor keeps their account but cannot be booked. The reason is audited.",
    confirm: "Reject",
  },
  suspend: {
    title: "Suspend doctor",
    description: "Hidden from booking and their desk. Existing bookings are flagged for the front desk.",
    confirm: "Suspend",
  },
  archive: {
    title: "Archive doctor",
    description: "Removes the doctor from the active roster. The reason is audited.",
    confirm: "Archive",
  },
  unarchive: {
    title: "Restore doctor",
    description: "Brings the doctor back to the roster as PENDING_VERIFICATION.",
    confirm: "Restore",
  },
}

/**
 * §29's doctor roster (Day 33). The lifecycle actions reuse the Day 16/27
 * endpoints; this page only adds the admin-shaped overview and the invite form.
 *
 * `mode="staff"` reuses the same roster and invitation machinery for the front
 * desk, but hides the credential decisions: staff may invite, suspend and
 * archive a doctor, never verify, reject, unsuspend or restore one.
 */
export default function Doctors({ mode = "admin" }: { mode?: "admin" | "staff" }) {
  const isAdmin = mode === "admin"
  const queryClient = useQueryClient()
  const [reasonAction, setReasonAction] = useState<{ action: ReasonAction; doctor: DoctorDetail } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [editDoctorId, setEditDoctorId] = useState<string | null>(null)

  const doctors = useQuery({
    queryKey: ["staff", "doctors"],
    queryFn: ({ signal }) => apiStaffDoctors(signal),
  })

  const invitations = useQuery({
    queryKey: ["doctor-invitations"],
    queryFn: ({ signal }) => apiDoctorInvitations(signal).then((result) => result.invitations),
  })

  const editDoctor = editDoctorId ? doctors.data?.doctors.find((d) => d.id === editDoctorId) ?? null : null

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["staff", "doctors"] })
    void queryClient.invalidateQueries({ queryKey: ["doctor-invitations"] })
    void queryClient.invalidateQueries({ queryKey: ["admin"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "doctors"] })
  }

  const verify = useMutation({
    mutationFn: (id: string) => apiVerifyDoctor(id),
    onSuccess: (result) => {
      setNotice(result.message)
      refresh()
    },
  })
  const unsuspend = useMutation({
    mutationFn: (id: string) => apiUnsuspendDoctor(id),
    onSuccess: (result) => {
      setNotice(result.message)
      refresh()
    },
  })
  const reasonMutation = useMutation({
    mutationFn: ({ action, doctor, reason }: { action: ReasonAction; doctor: DoctorDetail; reason: string }) => {
      switch (action) {
        case "reject":
          return apiRejectDoctor(doctor.id, reason)
        case "suspend":
          return apiSuspendDoctor(doctor.id, reason)
        case "archive":
          return apiArchiveDoctor(doctor.id, reason)
        case "unarchive":
          return apiUnarchiveDoctor(doctor.id, reason)
      }
    },
    onSuccess: (result) => {
      setNotice(result.message)
      setReasonAction(null)
      refresh()
    },
  })

  const actionError =
    reasonMutation.error instanceof ApiError
      ? reasonMutation.error.message
      : verify.error instanceof ApiError
        ? verify.error.message
        : unsuspend.error instanceof ApiError
          ? unsuspend.error.message
          : undefined

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Doctors</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Doctor roster</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              {isAdmin
                ? "Verify credentials, suspend access, and keep the public roster honest."
                : "Invite doctors, suspend or archive access. Credential verification stays with an admin."}
            </p>
          </div>
          <Button onClick={() => setInviteOpen(true)}>Invite doctor</Button>
        </div>
      </section>

      {notice !== null && (
        <Alert className="rounded-2xl border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {actionError !== undefined && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Roster</CardTitle>
        </CardHeader>
        <CardContent>
          {doctors.isPending && <PageLoading label="Loading doctors…" />}
          {doctors.isError && (
            <PageError
              title="Doctors could not be loaded"
              message={doctors.error instanceof ApiError ? doctors.error.message : undefined}
              onRetry={() => void doctors.refetch()}
            />
          )}
          {doctors.data?.doctors.length === 0 && (
            <EmptyState title="No doctors yet" description="Invite the first doctor to start verifying the roster." />
          )}
          {doctors.data !== undefined && doctors.data.doctors.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th scope="col" className="py-3 pr-3 font-medium">Doctor</th>
                    <th scope="col" className="py-3 pr-3 font-medium">Status</th>
                    <th scope="col" className="py-3 pr-3 font-medium">Bookable</th>
                    <th scope="col" className="py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {doctors.data.doctors.map((doctor) => (
                    <tr key={doctor.id}>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-3">
                          <DoctorAvatar src={doctor.profileImageUrl} name={doctor.fullName} className="size-10 text-xs" />
                          <div className="min-w-0">
                            <p className="font-medium">{doctor.fullName}</p>
                            <p className="text-xs text-muted-foreground">{doctor.email}</p>
                            {doctor.suspendReason !== null && (
                              <p className="text-xs text-muted-foreground">Suspended: {doctor.suspendReason}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <StatusBadge doctor={doctor} />
                      </td>
                      <td className="py-3 pr-3">{doctor.isBookable ? "Yes" : "No"}</td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          {doctor.verificationStatus !== "ARCHIVED" && doctor.verificationStatus !== "REJECTED" && (
                            <Button size="sm" variant="outline" onClick={() => setEditDoctorId(doctor.id)}>
                              Edit profile
                            </Button>
                          )}
                          {isAdmin && doctor.verificationStatus === "PENDING_VERIFICATION" && (
                            <>
                              <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate(doctor.id)}>
                                Verify
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReasonAction({ action: "reject", doctor })}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                          {doctor.verificationStatus === "VERIFIED" && doctor.suspendedAt === null && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReasonAction({ action: "suspend", doctor })}
                            >
                              Suspend
                            </Button>
                          )}
                          {isAdmin && doctor.suspendedAt !== null && (
                            <Button size="sm" disabled={unsuspend.isPending} onClick={() => unsuspend.mutate(doctor.id)}>
                              Unsuspend
                            </Button>
                          )}
                          {isAdmin && doctor.verificationStatus === "ARCHIVED" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReasonAction({ action: "unarchive", doctor })}
                            >
                              Restore
                            </Button>
                          ) : (
                            doctor.verificationStatus !== "ARCHIVED" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReasonAction({ action: "archive", doctor })}
                              >
                                Archive
                              </Button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <PendingInvitationsCard
        title="Pending doctor invitations"
        description={
          isAdmin
            ? "Unclaimed invitations are not accounts yet. Resending replaces the old link and restarts the one-hour clock."
            : "Unclaimed invitations are not accounts yet. You can resend or revoke any invitation on this list."
        }
        invitations={invitations.data}
        isLoading={invitations.isPending}
        isError={invitations.isError}
        errorMessage={invitations.error instanceof ApiError ? invitations.error.message : undefined}
        onRetry={() => void invitations.refetch()}
        onResend={apiResendDoctorInvitation}
        onRevoke={apiRevokeDoctorInvitation}
        onChanged={refresh}
      />

      {reasonAction !== null && (
        <ReasonDialog
          open
          onOpenChange={(open) => {
            if (!open) setReasonAction(null)
          }}
          title={REASON_COPY[reasonAction.action].title}
          description={REASON_COPY[reasonAction.action].description}
          confirmLabel={REASON_COPY[reasonAction.action].confirm}
          pending={reasonMutation.isPending}
          error={actionError}
          onConfirm={(reason) =>
            reasonMutation.mutate({
              action: reasonAction.action,
              doctor: reasonAction.doctor,
              reason,
            })
          }
        />
      )}

      <InviteDoctorDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(message) => {
          setNotice(message)
          setInviteOpen(false)
          refresh()
        }}
      />

      <DoctorProfileDialog
        doctor={editDoctor}
        open={editDoctorId !== null}
        onOpenChange={(open) => {
          if (!open) setEditDoctorId(null)
        }}
      />
    </div>
  )
}

function StatusBadge({ doctor }: { doctor: DoctorDetail }) {
  if (doctor.suspendedAt !== null) return <Badge variant="destructive">Suspended</Badge>
  const variant =
    doctor.verificationStatus === "VERIFIED"
      ? "default"
      : doctor.verificationStatus === "PENDING_VERIFICATION"
        ? "outline"
        : "secondary"
  return <Badge variant={variant}>{doctor.verificationStatus.replaceAll("_", " ").toLowerCase()}</Badge>
}

function InviteDoctorDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInvited: (message: string) => void
}) {
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteDoctorInputShape>({
    resolver: zodResolver(inviteDoctorSchema),
    defaultValues: { fullName: "", email: "" },
  })
  const invite = useMutation({
    mutationFn: (values: InviteDoctorInputShape) => apiInviteDoctor(values),
    onSuccess: (result) => {
      onInvited(result.message)
      reset()
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError) ?? null)
    },
  })

  const submit = handleSubmit((values) => {
    setFormError(null)
    invite.mutate(values)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Invite a doctor</DialogTitle>
            <DialogDescription>
              Sends a verification email. The doctor appears as pending until an admin verifies their credentials.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="doctor-full-name">Full name</Label>
            <Input
              id="doctor-full-name"
              aria-invalid={errors.fullName !== undefined}
              aria-describedby={errors.fullName !== undefined ? "doctor-full-name-error" : undefined}
              {...register("fullName")}
            />
            {errors.fullName?.message !== undefined && (
              <p id="doctor-full-name-error" className="text-xs text-destructive" role="alert">
                {errors.fullName.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="doctor-email">Email</Label>
            <Input
              id="doctor-email"
              type="email"
              aria-invalid={errors.email !== undefined}
              aria-describedby={errors.email !== undefined ? "doctor-email-error" : undefined}
              {...register("email")}
            />
            {errors.email?.message !== undefined && (
              <p id="doctor-email-error" className="text-xs text-destructive" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>

          {formError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Invite failed</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || invite.isPending}>
              {invite.isPending ? "Inviting…" : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
