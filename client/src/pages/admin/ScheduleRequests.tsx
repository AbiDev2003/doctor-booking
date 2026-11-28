import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  apiAdminScheduleRequests,
  apiApproveScheduleRequest,
  apiRejectScheduleRequest,
  ApiError,
} from "@/lib/api"
import type { DoctorScheduleChangeRequest, DoctorScheduleChangeStatus, DoctorScheduleChangeType } from "@/lib/api"
import { ReasonDialog } from "@/components/staff/reason-dialog"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

const SELECT_CLASS =
  "h-10 rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

const TYPE_LABEL: Record<DoctorScheduleChangeType, string> = {
  WINDOW_CREATE: "New weekly window",
  WINDOW_UPDATE: "Weekly window edit",
  WINDOW_DELETE: "Weekly window removal",
  UNAVAILABILITY_CREATE: "Time off",
  UNAVAILABILITY_DELETE: "Time-off removal",
}

const STATUSES: DoctorScheduleChangeStatus[] = ["PENDING", "APPROVED", "REJECTED"]

/**
 * Admin-only review queue for doctor-proposed schedule and time-off changes.
 * The live template, slots, bookings and unavailability rows stay untouched
 * until approval here; rejection only records the decision and emails the
 * doctor.
 */
export default function ScheduleRequests() {
  const [searchParams] = useSearchParams()
  const highlightedId = searchParams.get("request")
  const queryClient = useQueryClient()

  const [status, setStatus] = useState<DoctorScheduleChangeStatus>("PENDING")
  const [rejectTarget, setRejectTarget] = useState<DoctorScheduleChangeRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const requests = useQuery({
    queryKey: ["admin", "schedule-requests", status],
    queryFn: ({ signal }) => apiAdminScheduleRequests(status, signal).then((result) => result.requests),
  })

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["admin", "schedule-requests"] })
    void queryClient.invalidateQueries({ queryKey: ["doctor", "schedule-requests"] })
    void queryClient.invalidateQueries({ queryKey: ["doctor", "schedule"] })
    void queryClient.invalidateQueries({ queryKey: ["doctor", "unavailabilities"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "availability"] })
    void queryClient.invalidateQueries({ queryKey: ["admin"] })
  }

  const approve = useMutation({
    mutationFn: (id: string) => apiApproveScheduleRequest(id),
    onSuccess: (result) => {
      setNotice(result.message)
      refresh()
    },
  })

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => apiRejectScheduleRequest(id, reason),
    onSuccess: (result) => {
      setNotice(result.message)
      setRejectTarget(null)
      refresh()
    },
  })

  const actionError =
    approve.error instanceof ApiError
      ? approve.error.message
      : reject.error instanceof ApiError
        ? reject.error.message
        : undefined

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Schedule approvals</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Doctor change requests</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Review doctor-submitted windows and time off. Approving applies the change; rejecting leaves the live
          schedule exactly as it is.
        </p>
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
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-xl text-slate-950">Requests</CardTitle>
          <div className="space-y-1">
            <Label htmlFor="schedule-request-status">Status</Label>
            <select
              id="schedule-request-status"
              className={SELECT_CLASS}
              value={status}
              onChange={(event) => setStatus(event.target.value as DoctorScheduleChangeStatus)}
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.charAt(0) + value.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {requests.isPending && <PageLoading label="Loading schedule requests…" />}
          {requests.isError && (
            <PageError
              title="Schedule requests could not be loaded"
              message={requests.error instanceof ApiError ? requests.error.message : undefined}
              onRetry={() => void requests.refetch()}
            />
          )}
          {requests.data?.length === 0 && (
            <EmptyState
              title={`No ${status.toLowerCase()} requests`}
              description="Doctor-submitted schedule changes will appear here when they need a decision."
            />
          )}
          {requests.data?.map((request) => (
            <div
              key={request.id}
              id={`schedule-request-${request.id}`}
              className={`rounded-2xl border p-4 ${request.id === highlightedId ? "border-primary ring-2 ring-primary/20" : "border-slate-200"}`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-slate-950">{TYPE_LABEL[request.type]}</p>
                    <Badge variant={request.status === "PENDING" ? "outline" : "secondary"}>{request.status}</Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {request.doctorName} · {request.doctorEmail ?? "No email"} ·{" "}
                    {request.doctorPhone ?? "No mobile on file"}
                  </p>
                  <p className="text-muted-foreground">
                    Requested by {request.requestedByName} on {new Date(request.requestedAt).toLocaleString()}
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {request.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">Reason: {request.reason}</p>
                  {request.affectedPreview !== null && (
                    <p className="text-xs text-muted-foreground">
                      {request.affectedPreview} confirmed booking{request.affectedPreview === 1 ? "" : "s"} would be
                      affected when approved.
                    </p>
                  )}
                  {request.reviewedByName !== null && request.reviewedAt !== null && (
                    <p className="text-xs text-muted-foreground">
                      {request.status.toLowerCase()} by {request.reviewedByName} on{" "}
                      {new Date(request.reviewedAt).toLocaleString()}
                      {request.reviewNote !== null ? ` — ${request.reviewNote}` : ""}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Nothing live changes while this request is pending.
                  </p>
                </div>
                {request.status === "PENDING" && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(request.id)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejectTarget(request)}>
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <ReasonDialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null)
        }}
        title="Reject schedule change"
        description="The doctor's live schedule stays unchanged. The reason is recorded and emailed to the doctor."
        confirmLabel="Reject request"
        pending={reject.isPending}
        error={reject.error instanceof ApiError ? reject.error.message : undefined}
        onConfirm={(reason) => {
          if (rejectTarget !== null) reject.mutate({ id: rejectTarget.id, reason })
        }}
      />
    </div>
  )
}
