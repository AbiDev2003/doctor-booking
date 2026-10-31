import { useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { apiAudit, ApiError } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

/** §20's audit browser (Day 33): cursor-paged, filterable, ADMIN-only. */
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every reason-bearing action, newest first. Filter by target to reconstruct one record's history.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Trail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setFilters({ targetType: targetType.trim(), targetId: targetId.trim(), action: action.trim() })
            }}
          >
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Target type</span>
              <Input value={targetType} onChange={(event) => setTargetType(event.target.value)} placeholder="doctor" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Target id</span>
              <Input value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="uuid" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Action</span>
              <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder="doctor.verify" />
            </label>
            <Button type="submit" variant="outline">
              Apply
            </Button>
            {(filters.targetType !== "" || filters.targetId !== "" || filters.action !== "") && (
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
            )}
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
            <ul className="divide-y">
              {entries.map((entry) => (
                <li key={entry.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{entry.action}</span>
                    <Badge variant="outline">
                      {entry.targetType} · {entry.targetId.slice(0, 8)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {entry.actorName} ({entry.actorRole ?? "system"}) ·{" "}
                    {formatSlotDate(entry.createdAt.slice(0, 10))}
                    {entry.reason === null ? "" : ` · ${entry.reason}`}
                  </p>
                  {(entry.before !== null || entry.after !== null) && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Before / after</summary>
                      <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3">
                        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          {audit.hasNextPage && (
            <Button variant="outline" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
              {audit.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
