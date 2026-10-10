import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { DbClient } from "../lib/prisma.js";
import { selectOnlyConfirmed } from "../lib/unavailability.js";
import { writeAudit } from "./audit.service.js";
import { queueNotification } from "./notification.service.js";
import type { ActorContext } from "./doctor.service.js";

/**
 * plan.md §12 — the affected-appointment cascade, Day 18.
 *
 * Two halves, both here because §12 says a suspension/offboarding "reuses this
 * same cascade":
 *
 * 1. **Mark time** (`applyUnavailabilityCascade`) — when a disruption is
 *    created, every CONFIRMED appointment whose slot overlaps the window is
 *    flagged clinic-caused and its patient queued a notification. This runs
 *    INSIDE the caller's transaction so the marker and the notification rows
 *    commit with the disruption; if any write fails, none of it happened and
 *    no patient was told about a disruption that does not exist.
 *
 * 2. **Slot end** (`autoCancelAfterSlotEnd`) — the §12 auto-cancel job. Once a
 *    flagged appointment's slot has ended, the booking is cancelled and the
 *    refund path is opened, with `actorName = "system"` on every record
 *    (schema.prisma:849). Nothing schedules this yet — the interval runner is
 *    Day 29 — but the job is real and the DoD calls it directly.
 *
 * **The [T] rule is not a special case; it is the selection filter.**
 * `selectOnlyConfirmed` (`lib/unavailability.ts`) is the one predicate both
 * halves apply, so ARRIVED/COMPLETED/NO_SHOW rows are never marked and never
 * auto-cancelled — attendance is never overwritten.
 */

/**
 * The far-future end for a suspension/archive cascade, which has no window: the
 * disruption is open-ended, so every FUTURE CONFIRMED booking is affected. A
 * concrete sentinel (rather than a null) keeps the overlap query uniform, and
 * 9999 is comfortably inside Postgres's timestamptz range.
 */
export const OPEN_ENDED_WINDOW_END = new Date("9999-12-31T23:59:59.999Z");

export interface CascadeInput {
  readonly doctorId: string;
  /** Half-open `[startAt, endAt)` — a disruption's own window or `now → OPEN_ENDED`. */
  readonly window: { readonly startAt: Date; readonly endAt: Date };
  /**
   * The `DoctorUnavailability.id` to stamp on unmarked rows, or null when the
   * trigger has no such row (a suspension): the patients are still notified,
   * but there is no marker to set.
   */
  readonly disruptionId: string | null;
  readonly reason: string;
  readonly actor: ActorContext;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface CascadeResult {
  readonly affectedAppointmentIds: readonly string[];
}

/**
 * Flags every still-CONFIRMED appointment of `doctorId` overlapping `window`
 * and queues each patient a `DOCTOR_UNAVAILABLE` notification.
 *
 * **The first marker wins.** When a second disruption overlaps an appointment
 * already flagged by an earlier one, the existing `doctorUnavailabilityId` is
 * LEFT ALONE (schema comment: one marker, no overwrite) but the patient is
 * notified again — overlapping disruptions are two real events, and §18 makes
 * only the reminder once-only. That asymmetry is the reason the query does not
 * simply filter `doctorUnavailabilityId: null`.
 *
 * Must be called inside a transaction; the caller owns the row this writes.
 */
export async function applyUnavailabilityCascade(
  client: DbClient,
  input: CascadeInput,
): Promise<CascadeResult> {
  const overlapping = await client.appointment.findMany({
    where: {
      doctorId: input.doctorId,
      // The window test is the same half-open overlap the read model uses, in
      // SQL: `slot.startAt < end AND slot.endAt > start`.
      slot: { startAt: { lt: input.window.endAt }, endAt: { gt: input.window.startAt } },
    },
    select: {
      id: true,
      status: true,
      slotId: true,
      doctorUnavailabilityId: true,
      patient: { select: { email: true } },
    },
  });

  const affectedAppointmentIds: string[] = [];

  // The shared [T] predicate, applied even though the query could have filtered
  // — so the rule has exactly one implementation (lib/unavailability.ts).
  for (const appointment of selectOnlyConfirmed(overlapping)) {
    if (input.disruptionId !== null && appointment.doctorUnavailabilityId === null) {
      await client.appointment.update({
        where: { id: appointment.id },
        data: { doctorUnavailabilityId: input.disruptionId },
      });
    }

    // §16: a provisional desk patient may have no email; `recipient` is NOT
    // NULL, so a patient with nowhere to send is skipped rather than stored as
    // an empty address.
    if (appointment.patient.email) {
      await queueNotification(client, {
        type: $Enums.NotificationType.DOCTOR_UNAVAILABLE,
        recipient: appointment.patient.email,
        appointmentId: appointment.id,
        slotId: appointment.slotId,
      });
    }

    affectedAppointmentIds.push(appointment.id);
  }

  return { affectedAppointmentIds };
}

export interface AutoCancelResult {
  readonly cancelledAppointmentIds: readonly string[];
}

/**
 * The §12 auto-cancel job body. Cancels every flagged appointment whose slot
 * has ended, one appointment per transaction.
 *
 * Per-appointment transactions are deliberate: a single patient's slot end and
 * their refund seam must commit together, and one bad row must not roll back
 * the rest of a batch. The status is re-read and the update is conditional
 * (`WHERE status = CONFIRMED`) so a patient who cancelled a microsecond earlier
 * wins and the job quietly does nothing for that row.
 */
export async function autoCancelAfterSlotEnd(now: Date = new Date()): Promise<AutoCancelResult> {
  const due = await prisma.appointment.findMany({
    where: {
      status: $Enums.AppointmentStatus.CONFIRMED,
      doctorUnavailabilityId: { not: null },
      slot: { endAt: { lte: now } },
    },
    select: { id: true },
  });

  const cancelledAppointmentIds: string[] = [];
  for (const { id } of due) {
    if (await autoCancelOne(id, now)) {
      cancelledAppointmentIds.push(id);
    }
  }
  return { cancelledAppointmentIds };
}

async function autoCancelOne(appointmentId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        slotId: true,
        doctorUnavailabilityId: true,
        patient: { select: { email: true } },
      },
    });

    // Re-read and re-apply the shared predicate inside the transaction: a row
    // that moved out of CONFIRMED between the batch read and now is not ours
    // to cancel.
    if (!appointment || selectOnlyConfirmed([appointment]).length === 0) {
      return false;
    }

    const updated = await tx.appointment.updateMany({
      where: { id: appointmentId, status: $Enums.AppointmentStatus.CONFIRMED },
      data: { status: $Enums.AppointmentStatus.CANCELLED },
    });
    if (updated.count !== 1) return false;

    // The seat the booking held is freed (§8.1). Guarded by `gt: 0` so a stale
    // counter can never drive it negative — the CHECK (booked_count >= 0) is
    // not something this job may rely on Postgres to catch.
    await tx.slot.updateMany({
      where: { id: appointment.slotId, bookedCount: { gt: 0 } },
      data: { bookedCount: { decrement: 1 } },
    });

    const reason = "Doctor unavailable — cancelled automatically at slot end (§12)";

    await tx.appointmentHistory.create({
      data: {
        appointmentId,
        eventType: $Enums.AppointmentEventType.CANCELLED,
        fromStatus: $Enums.AppointmentStatus.CONFIRMED,
        toStatus: $Enums.AppointmentStatus.CANCELLED,
        actorId: null,
        actorRole: null,
        actorName: "system",
        reason,
        metadata: { doctorUnavailabilityId: appointment.doctorUnavailabilityId, autoCancelledAt: now.toISOString() },
      },
    });

    if (appointment.patient.email) {
      await queueNotification(tx, {
        type: $Enums.NotificationType.APPOINTMENT_AUTO_CANCELLED,
        recipient: appointment.patient.email,
        appointmentId,
        slotId: appointment.slotId,
      });
    }

    await settleClinicCausedRefund(tx, appointmentId, reason);

    await writeAudit(tx, {
      action: "APPOINTMENT_AUTO_CANCELLED",
      targetType: "appointment",
      targetId: appointmentId,
      actor: { name: "system" },
      before: { status: $Enums.AppointmentStatus.CONFIRMED },
      after: { status: $Enums.AppointmentStatus.CANCELLED },
      reason,
    });

    return true;
  });
}

/**
 * §17 case 1's backend-raised full refund, as a seam.
 *
 * There is no `Payment` row until Phase 5 (Days 23–26), so today this is a
 * no-op for every real appointment. When a PAID payment exists it raises the
 * `CLINIC_CAUSED` refund the plan requires, `PENDING` because the gateway call
 * is Day 25's executor. Keyed by the `(paymentId, kind)` unique index and
 * upserted so a retried auto-cancel cannot double-refund.
 */
async function settleClinicCausedRefund(client: DbClient, appointmentId: string, reason: string): Promise<void> {
  const payment = await client.payment.findFirst({
    where: { appointmentId, status: $Enums.PaymentStatus.PAID },
    orderBy: { createdAt: "desc" },
    select: { id: true, amountPaise: true },
  });
  if (!payment) return;

  await client.refund.upsert({
    where: { paymentId_kind: { paymentId: payment.id, kind: $Enums.RefundKind.CLINIC_CAUSED } },
    create: {
      paymentId: payment.id,
      kind: $Enums.RefundKind.CLINIC_CAUSED,
      amountPaise: payment.amountPaise,
      status: $Enums.RefundStatus.PENDING,
      reason,
      actorId: null,
      actorRole: null,
      actorName: "system",
    },
    update: {},
  });
}
