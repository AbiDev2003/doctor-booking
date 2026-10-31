import { Badge } from "@/components/ui/badge"
import type { AppointmentStatus } from "@/lib/api"

const LABELS: Record<AppointmentStatus, string> = {
  CONFIRMED: "Confirmed",
  ARRIVED: "Arrived",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
  NO_SHOW: "No-show",
  PENDING: "Pending",
}

const VARIANTS: Record<AppointmentStatus, "default" | "secondary" | "destructive" | "outline"> = {
  CONFIRMED: "default",
  ARRIVED: "secondary",
  COMPLETED: "outline",
  CANCELLED: "outline",
  REJECTED: "destructive",
  NO_SHOW: "destructive",
  PENDING: "secondary",
}

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>
}
