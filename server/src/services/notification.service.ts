import { $Enums } from "../generated/prisma/client.js";
import { getMailer, type EmailContent, type Mailer } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";
import { prisma, type DbClient } from "../lib/prisma.js";

/**
 * plan.md §18 — the notification write seam (Day 18) and its sender (Day 27).
 *
 * The split is deliberate and is the plan's core reliability rule:
 *
 * - `queueNotification` writes a `PENDING` row inside the caller's transaction,
 *   so the intent to tell someone commits with the change that caused it.
 * - `dispatchNotification` sends one queued row through the configured mailer
 *   and moves it to `SENT` or `FAILED`. It runs after the transaction commits,
 *   never inside the request's critical path.
 *
 * There is no retry queue and no attempt counter (§18). A `FAILED` row is the
 * human-visible record; re-sending is a deliberate action, not an automatic one.
 */
export interface QueuedNotification {
  readonly type: $Enums.NotificationType;
  /** The address to email. Required by the schema; callers skip patients with none. */
  readonly recipient: string;
  readonly appointmentId?: string | null | undefined;
  readonly slotId?: string | null | undefined;
}

export interface QueuedNotificationResult {
  readonly id: string;
}

/**
 * Writes one `PENDING` notification row inside the caller's transaction, so the
 * intent to notify commits atomically with the change that caused it.
 *
 * Deliberately insert-only and one row per event: §18 constrains ONLY the
 * reminder to be once-only, because repeated events (a second overlapping
 * unavailability) legitimately email more than once. The caller decides whether
 * a recipient exists at all — a provisional desk patient with no email gets no
 * row, since `recipient` is NOT NULL (schema.prisma).
 */
export async function queueNotification(
  client: DbClient,
  input: QueuedNotification,
): Promise<QueuedNotificationResult> {
  const row = await client.notification.create({
    data: {
      type: input.type,
      status: $Enums.NotificationStatus.PENDING,
      recipient: input.recipient,
      appointmentId: input.appointmentId ?? null,
      slotId: input.slotId ?? null,
    },
    select: { id: true },
  });

  return row;
}

export interface DispatchOptions {
  /** Injected by tests and DoD scripts so no real email leaves the machine. */
  readonly mailer?: Mailer | undefined;
}

const MAX_ERROR_LENGTH = 2_000;

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Sends one queued notification and records the outcome on its own row.
 *
 * The recipient is read back from the row rather than trusted from the caller:
 * `Notification.recipient` is the snapshot of what was actually addressed, and a
 * send that used anything else would make the audit trail a lie.
 *
 * A re-dispatch of a `SENT` row is a no-op, so a crash after the provider
 * accepted the message does not email twice. A `FAILED` row may be retried;
 * success clears the old error.
 */
export async function dispatchNotification(
  notificationId: string,
  content: EmailContent,
  options: DispatchOptions = {},
): Promise<void> {
  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { recipient: true, status: true },
  });

  if (!row) {
    logger.error({ notificationId }, "queued notification disappeared before dispatch");
    return;
  }

  if (row.status === $Enums.NotificationStatus.SENT) {
    return;
  }

  const mailer = options.mailer ?? getMailer();

  try {
    await mailer.send({
      to: row.recipient,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });

    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: $Enums.NotificationStatus.SENT,
        sentAt: new Date(),
        error: null,
      },
    });
  } catch (err) {
    logger.error({ err, notificationId }, "notification send failed");

    try {
      await prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: $Enums.NotificationStatus.FAILED,
          error: errorMessage(err),
        },
      });
    } catch (updateErr) {
      logger.error({ err: updateErr, notificationId }, "failed to mark notification as failed");
    }
  }
}

/**
 * Fire-and-forget dispatch: the HTTP response never waits on Resend (§18).
 *
 * `setImmediate` rather than a queue is the plan's locked MVP choice — the
 * process is the scheduler, and an in-flight send dying with the process is
 * visible as a row still `PENDING`.
 */
export function dispatchNotificationInBackground(
  notificationId: string,
  content: EmailContent,
  options: DispatchOptions = {},
): void {
  setImmediate(() => {
    void dispatchNotification(notificationId, content, options).catch((err: unknown) => {
      logger.error({ err, notificationId }, "notification dispatch crashed");
    });
  });
}
