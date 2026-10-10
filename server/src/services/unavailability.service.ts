import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { localDateTimeToUtc, utcToLocalDateTime } from "../lib/time.js";
import { assertValidDisruptionWindow } from "../lib/unavailability.js";
import { getClinicSettings } from "./clinic.service.js";
import { applyUnavailabilityCascade } from "./appointmentCascade.service.js";
import { writeAudit } from "./audit.service.js";
import { writeDoctorHistory } from "./doctor.service.js";
import type { ActorContext } from "./doctor.service.js";
import type { DoctorUnavailabilityDto } from "../schemas/unavailability.js";

/**
 * plan.md §12 — the DoctorUnavailability write surface, Day 18.
 *
 * Shape, mirroring slot.service.ts:
 *
 *   read the target → check the actor (§4/§5.2 roles) → ONE transaction {
 *   insert the disruption + run the §12 cascade + writeAudit +
 *   writeDoctorHistory }.
 *
 * **What "close the affected slots" means here (decision 1).** It is a READ
 * concern, not a write one: the Day 17 read model already hides any slot
 * overlapping a `DoctorUnavailability`, so inserting the row closes the slots
 * and deleting it reopens them — with no slot row ever mutated. Marking a slot
 * `isDisabled` would also have to be reverted on removal, and would lie about
 * why the slot was closed.
 *
 * **The cascade runs inside the transaction.** §12's marker + notification rows
 * must commit atomically with the disruption that caused them; only the email
 * SEND is deferred (Phase 7). See `appointmentCascade.service.ts`.
 *
 * **Removal is blocked while any appointment references the row** (decision 3):
 * the FK is `onDelete: Restrict`, and a nulled marker would erase the
 * clinic-caused fact §17 refunds depend on. A 409 explains it rather than a raw
 * FK 500.
 *
 * **Roles (decision §4).** ADMIN/STAFF manage any doctor; a DOCTOR only their
 * own — re-checked here even though the route gates (Day 12 double-enforcement).
 */

export interface UnavailabilityMutationInput {
  readonly actor: ActorContext;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface CreateUnavailabilityInput extends UnavailabilityMutationInput {
  readonly doctorId: string;
  /** Clinic-local `YYYY-MM-DD`. */
  readonly date: string;
  /** Clinic-local `HH:MM`. */
  readonly startTime: string;
  readonly endTime: string;
  readonly reason: string;
}

export interface CreateUnavailabilityResult {
  readonly unavailability: DoctorUnavailabilityDto;
  /** How many existing CONFIRMED appointments the cascade flagged (§12). */
  readonly affectedCount: number;
}

export interface RemoveUnavailabilityInput extends UnavailabilityMutationInput {
  readonly unavailabilityId: string;
  readonly reason: string;
}

interface UnavailabilityRow {
  readonly id: string;
  readonly doctorId: string;
  readonly createdById: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason: string;
  readonly createdAt: Date;
}

/** ADMIN/STAFF manage anyone; a DOCTOR only their own row (§4/§5.2). */
function assertUnavailabilityActor(actor: ActorContext, doctorId: string): void {
  const isStaff = actor.role === $Enums.UserRole.ADMIN || actor.role === $Enums.UserRole.STAFF;
  const isSelf = actor.role === $Enums.UserRole.DOCTOR && actor.id === doctorId;
  if (!isStaff && !isSelf) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

/** §5.2: an unavailability belongs to a doctor that must still be one and not archived. */
async function loadDoctor(doctorId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: doctorId },
    select: { role: true, doctorProfile: { select: { verificationStatus: true } } },
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR || !user.doctorProfile) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  if (user.doctorProfile.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED) {
    throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived — unarchive before marking them unavailable");
  }
}

function toDto(row: UnavailabilityRow, timeZone: string): DoctorUnavailabilityDto {
  const localStart = utcToLocalDateTime(row.startAt, timeZone);
  const localEnd = utcToLocalDateTime(row.endAt, timeZone);
  return {
    id: row.id,
    doctorId: row.doctorId,
    createdById: row.createdById,
    date: localStart.date,
    startTime: localStart.time.slice(0, 5),
    endTime: localEnd.time.slice(0, 5),
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * POST /unavailabilities — mark a doctor unavailable over a window and run the
 * §12 cascade. Returns the row plus how many bookings were affected so the
 * caller can report "N appointments notified".
 */
export async function createDoctorUnavailability(
  input: CreateUnavailabilityInput,
): Promise<CreateUnavailabilityResult> {
  assertUnavailabilityActor(input.actor, input.doctorId);
  await loadDoctor(input.doctorId);

  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(422, "REASON_REQUIRED", "A reason is required");
  }

  const clinic = await getClinicSettings();
  const startAt = localDateTimeToUtc({ date: input.date, time: input.startTime }, clinic.timezone);
  const endAt = localDateTimeToUtc({ date: input.date, time: input.endTime }, clinic.timezone);
  assertValidDisruptionWindow(startAt, endAt);

  const { row, affectedCount } = await prisma.$transaction(async (tx) => {
    const created = (await tx.doctorUnavailability.create({
      data: {
        doctorId: input.doctorId,
        createdById: input.actor.id,
        startAt,
        endAt,
        reason,
      },
    })) as UnavailabilityRow;

    const cascade = await applyUnavailabilityCascade(tx, {
      doctorId: input.doctorId,
      window: { startAt, endAt },
      disruptionId: created.id,
      reason,
      actor: input.actor,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeAudit(tx, {
      action: "DOCTOR_UNAVAILABILITY_CREATED",
      targetType: "doctor_unavailability",
      targetId: created.id,
      actor: input.actor,
      after: {
        doctorId: input.doctorId,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        reason,
        affectedCount: cascade.affectedAppointmentIds.length,
      },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "UNAVAILABILITY_CREATED",
      actor: input.actor,
      metadata: {
        unavailabilityId: created.id,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        affectedCount: cascade.affectedAppointmentIds.length,
      },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return { row: created, affectedCount: cascade.affectedAppointmentIds.length };
  });

  return { unavailability: toDto(row, clinic.timezone), affectedCount };
}

/** GET /unavailabilities?doctorId=… — one doctor's disruptions, oldest first. */
export async function listDoctorUnavailabilities(
  doctorId: string,
  actor: ActorContext,
): Promise<DoctorUnavailabilityDto[]> {
  assertUnavailabilityActor(actor, doctorId);
  await loadDoctor(doctorId);

  const clinic = await getClinicSettings();
  const rows = await prisma.doctorUnavailability.findMany({
    where: { doctorId },
    orderBy: [{ startAt: "asc" }],
  });
  return rows.map((row) => toDto(row as UnavailabilityRow, clinic.timezone));
}

/**
 * DELETE /unavailabilities/:id — remove a disruption (which reopens the hidden
 * slots through the read model, decision 1).
 *
 * Refused with 409 `UNAVAILABILITY_IN_USE` while ANY appointment still carries
 * this marker — a cancelled clinic-caused booking keeps its marker (§12), so
 * removal is permanent once the cascade has run. The check precedes the delete
 * so the refusal is a plan-vocabulary 409, not a raw FK violation.
 */
export async function removeDoctorUnavailability(input: RemoveUnavailabilityInput): Promise<void> {
  const existing = (await prisma.doctorUnavailability.findUnique({
    where: { id: input.unavailabilityId },
  })) as UnavailabilityRow | null;
  if (!existing) {
    throw new AppError(404, "UNAVAILABILITY_NOT_FOUND", "Unavailability not found");
  }

  assertUnavailabilityActor(input.actor, existing.doctorId);

  await prisma.$transaction(async (tx) => {
    const referencing = await tx.appointment.count({
      where: { doctorUnavailabilityId: existing.id },
    });
    if (referencing > 0) {
      throw new AppError(
        409,
        "UNAVAILABILITY_IN_USE",
        "This unavailability has affected appointments and cannot be removed",
      );
    }

    await tx.doctorUnavailability.delete({ where: { id: existing.id } });

    await writeAudit(tx, {
      action: "DOCTOR_UNAVAILABILITY_REMOVED",
      targetType: "doctor_unavailability",
      targetId: existing.id,
      actor: input.actor,
      before: {
        doctorId: existing.doctorId,
        startAt: existing.startAt.toISOString(),
        endAt: existing.endAt.toISOString(),
        reason: existing.reason,
      },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: existing.doctorId,
      eventType: "UNAVAILABILITY_REMOVED",
      actor: input.actor,
      metadata: {
        unavailabilityId: existing.id,
        startAt: existing.startAt.toISOString(),
        endAt: existing.endAt.toISOString(),
      },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}
