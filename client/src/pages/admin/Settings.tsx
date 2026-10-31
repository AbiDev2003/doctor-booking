import { useState } from "react"
import type { FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiClinicSettings, apiInviteStaff, apiUpdateClinicSettings, ApiError } from "@/lib/api"
import type { ClinicSettingsPatch } from "@/lib/api"
import { PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

const FIELDS = [
  { key: "bookingHorizonDays", label: "Booking horizon (days)", min: 1, max: 365 },
  { key: "cancelCutoffMinutes", label: "Cancel cutoff (minutes)", min: 0, max: 10080 },
  { key: "holdDurationMinutes", label: "Seat hold (minutes)", min: 1, max: 120 },
  { key: "minLeadMinutes", label: "Minimum lead (minutes)", min: 0, max: 10080 },
  { key: "reminderLeadMinutes", label: "Reminder lead (minutes)", min: 0, max: 10080 },
  { key: "maxActiveBookingsPerPatient", label: "Max active bookings / patient", min: 1, max: 100 },
] as const

/** §29's settings tab (Day 33): the six scheduling tunables and staff invites. */
export default function Settings() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  const settings = useQuery({ queryKey: ["admin", "clinic-settings"], queryFn: ({ signal }) => apiClinicSettings(signal) })

  const save = useMutation({
    mutationFn: (patch: ClinicSettingsPatch) => apiUpdateClinicSettings(patch),
    onSuccess: (result) => {
      setNotice(result.message)
      setDraft({})
      void queryClient.invalidateQueries({ queryKey: ["admin", "clinic-settings"] })
      void queryClient.invalidateQueries({ queryKey: ["public", "clinic"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
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
  const patch: ClinicSettingsPatch = {}
  for (const field of FIELDS) {
    const raw = draft[field.key]
    if (raw === undefined || raw.trim() === "") continue
    const value = Number(raw)
    if (Number.isInteger(value) && value !== current[field.key]) patch[field.key] = value
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (Object.keys(patch).length === 0) {
      setNotice("No changes to save.")
      return
    }
    save.mutate(patch)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduling tunables apply clinic-wide. Name, timezone, currency and default fee are seed-owned.
          </p>
        </div>
        <Button variant="outline" onClick={() => setInviteOpen(true)}>
          Invite staff
        </Button>
      </div>

      {notice !== null && (
        <Alert>
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {save.error instanceof ApiError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save settings</AlertTitle>
          <AlertDescription>{save.error.message}</AlertDescription>
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
                    value={draft[field.key] ?? ""}
                    onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDraft({})}>
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <InviteStaffDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(message) => {
          setNotice(message)
          setInviteOpen(false)
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
  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState("")
  const invite = useMutation({
    mutationFn: () => apiInviteStaff({ email: email.trim(), fullName: fullName.trim() }),
    onSuccess: (result) => {
      onInvited(result.message)
      setEmail("")
      setFullName("")
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            invite.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite front-desk staff</DialogTitle>
            <DialogDescription>
              Staff can run the desk but cannot reach the admin dashboard.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="staff-full-name">Full name</Label>
            <Input
              id="staff-full-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="staff-email">Email</Label>
            <Input
              id="staff-email"
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
