import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { inviteStaffSchema, type InviteStaffInputShape } from "@shared/doctors"
import {
  apiInviteStaff,
  apiResendStaffInvitation,
  apiRevokeStaffInvitation,
  apiStaffAccounts,
  ApiError,
} from "@/lib/api"
import { applyApiErrors } from "@/lib/formErrors"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { PendingInvitationsCard } from "@/components/staff/pending-invitations"
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

/**
 * §29's Staff tab (ADMIN-only). Two lists, one story: accepted STAFF accounts
 * and unclaimed staff invitations. Invitations are not accounts — the `User`
 * row only appears when the recipient uses the one-hour claim link — so they
 * stay in their own table with resend/revoke beside them.
 */
export default function Staff() {
  const queryClient = useQueryClient()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const staff = useQuery({
    queryKey: ["admin", "staff"],
    queryFn: ({ signal }) => apiStaffAccounts(signal),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "staff"] })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Front-desk accounts and the invitations still waiting to be claimed.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>Invite staff</Button>
      </div>

      {notice !== null && (
        <Alert>
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Front-desk accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {staff.isPending && <PageLoading label="Loading staff…" />}
          {staff.isError && (
            <PageError
              title="Staff could not be loaded"
              message={staff.error instanceof ApiError ? staff.error.message : undefined}
              onRetry={() => void staff.refetch()}
            />
          )}
          {staff.data?.staff.length === 0 && (
            <EmptyState title="No staff yet" description="Invite the first front-desk member." />
          )}
          {staff.data !== undefined && staff.data.staff.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Staff member
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      Joined
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {staff.data.staff.map((member) => (
                    <tr key={member.id}>
                      <td className="py-3 pr-3">
                        <p className="font-medium">{member.fullName}</p>
                        <p className="text-xs text-muted-foreground">{member.email ?? "No email on file"}</p>
                      </td>
                      <td className="py-3 pr-3">
                        <Badge variant={member.isDeactivated ? "destructive" : "outline"}>
                          {member.isDeactivated ? "deactivated" : "active"}
                        </Badge>
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {formatSlotDate(member.createdAt.slice(0, 10))}
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
        title="Pending staff invitations"
        description="An invitation becomes a staff account only when the link is claimed. Resending replaces the old link and restarts the one-hour clock."
        invitations={staff.data?.invitations}
        isLoading={staff.isPending}
        isError={staff.isError}
        errorMessage={staff.error instanceof ApiError ? staff.error.message : undefined}
        onRetry={() => void staff.refetch()}
        onResend={apiResendStaffInvitation}
        onRevoke={apiRevokeStaffInvitation}
        onChanged={refresh}
      />

      <InviteStaffDialog
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

function InviteStaffDialog({
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
  } = useForm<InviteStaffInputShape>({
    resolver: zodResolver(inviteStaffSchema),
    defaultValues: { fullName: "", email: "" },
  })
  const invite = useMutation({
    mutationFn: (values: InviteStaffInputShape) => apiInviteStaff(values),
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
            <DialogTitle>Invite front-desk staff</DialogTitle>
            <DialogDescription>
              Staff can run the desk but cannot reach the admin dashboard. The account is created when they claim the
              link.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="staff-full-name">Full name</Label>
            <Input
              id="staff-full-name"
              aria-invalid={errors.fullName !== undefined}
              aria-describedby={errors.fullName !== undefined ? "staff-full-name-error" : undefined}
              {...register("fullName")}
            />
            {errors.fullName?.message !== undefined && (
              <p id="staff-full-name-error" className="text-xs text-destructive" role="alert">
                {errors.fullName.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="staff-email">Email</Label>
            <Input
              id="staff-email"
              type="email"
              aria-invalid={errors.email !== undefined}
              aria-describedby={errors.email !== undefined ? "staff-email-error" : undefined}
              {...register("email")}
            />
            {errors.email?.message !== undefined && (
              <p id="staff-email-error" className="text-xs text-destructive" role="alert">
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
