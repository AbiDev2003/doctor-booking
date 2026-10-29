import type { ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The shared loading / error / empty trio for the Phase 8 dashboards (Day 30).
 * One place so four dashboards do not drift into four spellings of "nothing
 * here" and four different retry buttons.
 */

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label={label}>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}

export function PageError({
  title = "Could not load this page",
  message,
  onRetry,
}: {
  title?: string
  message?: string
  onRetry?: () => void
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message ?? "Please try again."}</p>
        {onRetry !== undefined && (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/30 px-6 py-10 text-center">
      <p className="font-medium text-foreground">{title}</p>
      {description !== undefined && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {children !== undefined && <div className="mt-4 flex justify-center gap-2">{children}</div>}
    </div>
  )
}
