import { useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { apiAudit, ApiError } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function Audit() {
  const [targetType, setTargetType] = useState("")
  const [targetId, setTargetId] = useState("")
  const [action, setAction] = useState("")
  const [filters, setFilters] = useState({ targetType: "", targetId: "", action: "" })

  const audit = useInfiniteQuery({
    queryKey: ["admin", "audit", filters],
    initialPageParam: "" as string,
    queryFn: ({ pageParam, signal }) =>
      apiAudit(
        {
          ...(filters.targetType !== "" && { targetType: filters.targetType }),
          ...(filters.targetId !== "" && { targetId: filters.targetId }),
          ...(filters.action !== "" && { action: filters.action }),
          ...(pageParam !== "" && { cursor: pageParam }),
          limit: 50,
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const entries = audit.data?.pages.flatMap((page) => page.entries) ?? []

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Audit</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Audit trail</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Every reason-bearing action, newest first. Filter by target to reconstruct one record’s history.
        </p>
      </section>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Trail</CardTitle>
          <CardDescription>Filter audit entries by target type, target ID, or action.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto_auto] xl:items-end"
            onSubmit={(event) => {
              event.preventDefault()
              setFilters({ targetType: targetType.trim(), targetId: targetId.trim(), action: action.trim() })
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="audit-target-type">Target type</Label>
              <Input id="audit-target-type" className="bg-white" value={targetType} onChange={(event) => setTargetType(event.target.value)} placeholder="doctor" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="audit-target-id">Target id</Label>
              <Input id="audit-target-id" className="bg-white" value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="uuid" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="audit-action">Action</Label>
              <Input id="audit-action" className="bg-white" value={action} onChange={(event) => setAction(event.target.value)} placeholder="DOCTOR_VERIFIED" />
            </div>
            <Button type="submit" variant="outline" className="bg-white">Apply</Button>
            {(filters.targetType !== "" || filters.targetId !== "" || filters.action !== "") ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setTargetType("")
                  setTargetId("")
                  setAction("")
                  setFilters({ targetType: "", targetId: "", action: "" })
                }}
              >
                Clear
              </Button>
            ) : <div className="hidden xl:block" />}
          </form>

          {audit.isPending && <PageLoading label="Loading audit trail…" />}
          {audit.isError && (
            <PageError
              title="Audit trail could not be loaded"
              message={audit.error instanceof ApiError ? audit.error.message : undefined}
              onRetry={() => void audit.refetch()}
            />
          )}
          {!audit.isPending && entries.length === 0 && <EmptyState title="No audit entries match" />}

          {entries.length > 0 && (
            <ul className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.id} className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-950">{entry.action}</span>
                    <Badge variant="outline">{entry.targetType} · {entry.targetId.slice(0, 8)}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    {entry.actorName} ({entry.actorRole ?? "system"}) · {formatSlotDate(entry.createdAt.slice(0, 10))}
                    {entry.reason === null ? "" : ` · ${entry.reason}`}
                  </p>
                  {(entry.before !== null || entry.after !== null) && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Before / after</summary>
                      <pre className="mt-2 overflow-x-auto rounded-xl bg-white p-3 text-slate-700 ring-1 ring-slate-200">
                        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          {audit.hasNextPage && (
            <Button variant="outline" className="bg-white" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
              {audit.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
