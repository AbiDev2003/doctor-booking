import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  apiArchiveDoctor,
  apiInviteDoctor,
  apiRejectDoctor,
  apiStaffDoctors,
  apiSuspendDoctor,
  apiUnarchiveDoctor,
  apiUnsuspendDoctor,
  apiVerifyDoctor,
  ApiError,
} from "@/lib/api"
import type { DoctorDetail } from "@/lib/api"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
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
 */
export default function Doctors() {
  const queryClient = useQueryClient()
  const [reasonAction, setReasonAction] = useState<{ action: ReasonAction; doctor: DoctorDetail } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const doctors = useQuery({
    queryKey: ["staff", "doctors"],
    queryFn: ({ signal }) => apiStaffDoctors(signal),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["staff", "doctors"] })
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Doctors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Verify credentials, suspend access and keep the public roster honest.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>Invite doctor</Button>
      </div>

      {notice !== null && (
        <Alert>
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {actionError !== undefined && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
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
                <thead className="border-b text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Doctor</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Bookable</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {doctors.data.doctors.map((doctor) => (
                    <tr key={doctor.id}>
                      <td className="py-3 pr-3">
                        <p className="font-medium">{doctor.fullName}</p>
                        <p className="text-xs text-muted-foreground">{doctor.email}</p>
                        {doctor.suspendReason !== null && (
                          <p className="text-xs text-muted-foreground">Suspended: {doctor.suspendReason}</p>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <StatusBadge doctor={doctor} />
                      </td>
                      <td className="py-3 pr-3">{doctor.isBookable ? "Yes" : "No"}</td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          {doctor.verificationStatus === "PENDING_VERIFICATION" && (
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
                          {doctor.suspendedAt !== null && (
                            <Button size="sm" disabled={unsuspend.isPending} onClick={() => unsuspend.mutate(doctor.id)}>
                              Unsuspend
                            </Button>
                          )}
                          {doctor.verificationStatus === "ARCHIVED" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReasonAction({ action: "unarchive", doctor })}
                            >
                              Restore
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReasonAction({ action: "archive", doctor })}
                            >
                              Archive
                            </Button>
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
  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState("")
  const invite = useMutation({
    mutationFn: () => apiInviteDoctor({ email: email.trim(), fullName: fullName.trim() }),
    onSuccess: (result) => {
      onInvited(result.message)
      setEmail("")
      setFullName("")
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    invite.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
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
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="doctor-email">Email</Label>
            <Input
              id="doctor-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          {invite.error instanceof ApiError && (
            <Alert variant="destructive">
              <AlertTitle>Invite failed</AlertTitle>
              <AlertDescription>{invite.error.message}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending || email.trim() === "" || fullName.trim() === ""}>
              {invite.isPending ? "Inviting…" : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
