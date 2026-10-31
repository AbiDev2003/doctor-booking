import { useState } from "react"
import type { ReactNode } from "react"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

/**
 * One reason-capture dialog for every desk action that §8.4/§20 makes
 * reason-mandatory: reject, cancel, void, slot edits, disable/enable and
 * unavailability removal. The confirm button refuses to submit an empty reason
 * so the common mistake is a disabled button rather than a 422.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  pending: boolean
  error?: string | undefined
  onConfirm: (reason: string) => void
  children?: ReactNode
}) {
  const [reason, setReason] = useState("")

  function change(next: boolean) {
    if (!next) setReason("")
    onOpenChange(next)
  }

  const trimmed = reason.trim()

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {children}

        <div className="space-y-2">
          <Label htmlFor="reason">Reason</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this change being made?"
            maxLength={1000}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">Recorded in the audit trail (maximum 1000 characters).</p>
        </div>

        {error !== undefined && (
          <Alert variant="destructive">
            <AlertTitle>Could not complete the action</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || trimmed === ""}
            onClick={() => {
              if (trimmed !== "") onConfirm(trimmed)
            }}
          >
            {pending ? "Saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
