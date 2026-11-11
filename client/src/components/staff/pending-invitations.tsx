import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { MailPlus } from "lucide-react"
import { ApiError } from "@/lib/api"
import type { PendingInvitation } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { ReasonDialog } from "@/components/staff/reason-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Pending invitations shared by the admin Doctors page, the staff Doctors page
 * and the admin Staff page.
 *
 * An invitation is not an account: the row lives in `PendingInvitation` until
 * the recipient claims it. Resending replaces the token and restarts the
 * one-hour clock, so the older email stops working immediately; revoking closes
 * the row for good. Both are audited server-side — this card only wires the
 * buttons and refreshes the parent's queries.
 */
export function PendingInvitationsCard({
  title = "Pending invitations",
  description,
  invitations,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onResend,
  onRevoke,
  onChanged,
  emptyDescription = "No one is waiting to claim an invitation.",
}: {
  title?: string
  description?: string
  invitations: PendingInvitation[] | undefined
  isLoading: boolean
  isError: boolean
  errorMessage?: string | undefined
  onRetry: () => void
  onResend: (id: string) => Promise<{ message: string }>
  onRevoke: (id: string, reason: string) => Promise<{ message: string }>
  onChanged: () => void
  emptyDescription?: string
}) {
  const [revoking, setRevoking] = useState<PendingInvitation | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const resend = useMutation({
    mutationFn: (invitation: PendingInvitation) => onResend(invitation.id),
    onSuccess: (result) => {
      setNotice(result.message)
      onChanged()
    },
  })

  const revoke = useMutation({
    mutationFn: ({ invitation, reason }: { invitation: PendingInvitation; reason: string }) =>
      onRevoke(invitation.id, reason),
    onSuccess: (result) => {
      setNotice(result.message)
      setRevoking(null)
      onChanged()
    },
  })

  const actionError =
    resend.error instanceof ApiError
      ? resend.error.message
      : revoke.error instanceof ApiError
        ? revoke.error.message
        : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailPlus className="size-4" /> {title}
        </CardTitle>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="space-y-4">
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

        {isLoading && <PageLoading label="Loading invitations…" />}
        {isError && <PageError title="Invitations could not be loaded" message={errorMessage} onRetry={onRetry} />}
        {invitations !== undefined && invitations.length === 0 && (
          <EmptyState title="No pending invitations" description={emptyDescription}>
            <MailPlus className="size-4" />
          </EmptyState>
        )}
        {invitations !== undefined && invitations.length > 0 && (
          <ul className="divide-y">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{invitation.fullName}</span>
                    <Badge variant={invitation.status === "EXPIRED" ? "destructive" : "outline"}>
                      {invitation.status === "EXPIRED" ? "expired" : "pending"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{invitation.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited {formatSlotDate(invitation.createdAt.slice(0, 10))}
                    {invitation.invitedByName === null ? "" : ` by ${invitation.invitedByName}`}
                    {` · ${invitation.status === "EXPIRED" ? "expired" : "expires"} ${formatSlotDate(
                      invitation.expiresAt.slice(0, 10),
                    )}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resend.isPending}
                    onClick={() => resend.mutate(invitation)}
                  >
                    {resend.isPending ? "Sending…" : "Resend"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setRevoking(invitation)}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {revoking !== null && (
          <ReasonDialog
            open
            onOpenChange={(open) => {
              if (!open) setRevoking(null)
            }}
            title="Revoke invitation"
            description={`The link sent to ${revoking.email} stops working immediately. The recipient can be invited again later.`}
            confirmLabel="Revoke"
            pending={revoke.isPending}
            error={actionError}
            onConfirm={(reason) => revoke.mutate({ invitation: revoking, reason })}
          />
        )}
      </CardContent>
    </Card>
  )
}
