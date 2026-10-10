import { $Enums } from "../generated/prisma/client.js";
import type { DbClient } from "../lib/prisma.js";

/**
 * plan.md §18 — the Notification write seam, Day 18.
 *
 * The §12 cascade must record that every affected patient WILL be told; the
 * actual email send is Phase 7 (Day 27). So this writes the `Notification` row
 * — the durable, status-tracked record of an intended send — and nothing else.
 * The row starts `PENDING`, and `sentAt`/`error` stay null for the sender to
 * fill; a send that never happens is therefore visible to a human through the
 * existing `(status, createdAt)` index (§18), not lost.
 *
 * Deliberately insert-only and one row per event: §18 constrains ONLY the
 * reminder to be once-only, because repeated events (a second overlapping
 * unavailability) legitimately email more than once. The caller decides whether
 * a recipient exists at all — a provisional desk patient with no email gets no
 * row, since `recipient` is NOT NULL (schema.prisma:979).
 */
export interface QueuedNotification {
  readonly type: $Enums.NotificationType;
  /** The address to email. Required by the schema; callers skip patients with none. */
  readonly recipient: string;
  readonly appointmentId?: string | null | undefined;
  readonly slotId?: string | null | undefined;
}

/**
 * Writes one PENDING notification row inside the caller's transaction, so the
 * intent to notify commits atomically with the change that caused it. Phase 7
 * adds the send + the SENT/FAILED transition behind this same row.
 */
export async function queueNotification(client: DbClient, input: QueuedNotification): Promise<void> {
  await client.notification.create({
    data: {
      type: input.type,
      status: $Enums.NotificationStatus.PENDING,
      recipient: input.recipient,
      appointmentId: input.appointmentId ?? null,
      slotId: input.slotId ?? null,
    },
  });
}
