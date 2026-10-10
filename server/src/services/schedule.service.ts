import { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { windowsOverlap } from "../lib/slotPlan.js";
import { writeAudit } from "./audit.service.js";
import { materializeSlots } from "./slotGeneration.service.js";
import type { MaterializeStats } from "./slotGeneration.service.js";
import { logger } from "../lib/logger.js";
import type { ActorContext, RequestMeta } from "./doctor.service.js";
import type { ScheduleDto } from "../schemas/schedules.js";

/**
 * plan.md §11, §8.1, §8.3 — the weekly template CRUD, Day 15.
 *
 * Shape mirrors doctor.service.ts: read the target → check the actor and the
 * window's shape → ONE transaction { conditional write + writeAudit } → then
 * (after commit) materialise the horizon.
 *
 * **Materialisation runs after the transaction, not inside it.** The template
 * row is the source of truth (§11); slots are derived. Running the generator
 * inside the commit would make "did the template save?" depend on 60 days of
 * slot inserts succeeding — a DST-skip bug or a slow batch would roll back a
 * perfectly good window. Instead the transaction commits the window and its
 * audit row atomically, then the generator tops the horizon up. If
 * materialisation itself fails, the response says so and
 * `POST /schedules/materialize` re-runs it: a missing slot can always be
 * created later; an unsaved template with created slots is the unfixable
 * direction.
 *
 * **Delete does NOT touch slots.** §11: a template edit applies to
 * not-yet-generated dates only. Removing the window stops future dates from
 * gaining slots; slots already generated are corrected through Day 16's
 * audited slot-edit/disable path, because patients may already hold seats in
 * them and a silent cascade delete would strand those bookings.
 *
 * **Overlap is an app-level 422 (decision 3)**, checked before the write so
 * the error names the conflict; the `(doctorId, weekday, startTime)` unique
 * key backstops the race between two creators and surfaces as a 409 via
 * `isUniqueConstraintViolation`.
 *
 * **Roles (decision 2):** ADMIN/STAFF manage any doctor's template; a DOCTOR
 * manages only their own (`assertScheduleAccess`, re-checked here even though
 * the route gates — the double-enforcement rule from doctor.service.ts). A
 * DOCTOR may not change `maxPatients` on PATCH (403): capacity is §8.3 clinic
 * configuration, the same split that keeps `consultationFee` admin-only.
 *
 * Audit actions: `SCHEDULE_CREATED`, `SCHEDULE_UPDATED`, `SCHEDULE_DELETED`,
 * targetType `schedule`, before/after snapshots of the window (decision 6).
 */

/** What every mutation here contributes to its §20 audit row. */
export interface ScheduleMutationInput extends RequestMeta {
  readonly actor: ActorContext;
}

export interface CreateScheduleInput extends ScheduleMutationInput {
  readonly doctorId: string;
  readonly weekday: $Enums.Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
  readonly reason?: string | undefined;
}

export interface UpdateScheduleInput extends ScheduleMutationInput {
  readonly scheduleId: string;
  readonly patch: {
    readonly weekday?: $Enums.Weekday | undefined;
    readonly startTime?: string | undefined;
    readonly endTime?: string | undefined;
    readonly maxPatients?: number | undefined;
  };
  readonly reason: string;
}

export interface DeleteScheduleInput extends ScheduleMutationInput {
  readonly scheduleId: string;
  readonly reason: string;
}

/**
 * The result of a mutation that re-runs the generator: the window's own DTO
 * plus what the horizon top-up did. `materialized` is null when the generator
 * could not run (logged, schedule still saved) — the honest shape for "the
 * template landed, the slots are one POST /schedules/materialize away".
 */
export interface ScheduleMutationResult {
  readonly schedule: ScheduleDto;
  readonly materialized: MaterializeStats | null;
}

interface ScheduleRow {
  readonly id: string;
  readonly doctorId: string;
  readonly weekday: $Enums.Weekday;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly maxPatients: number;
  /** The concurrent-edit detector for the conditional delete. */
  readonly updatedAt: Date;
}

/** The window's shape before it has a row — what create audits as `after`. */
interface WindowShape {
  readonly doctorId: string;
  readonly weekday: $Enums.Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` clients and audits speak. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** `@db.Time(0)` write value: UTC-anchored 1970-01-01 (the seed's `timeOf` shape). */
function timeValue(time: string): Date {
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(Date.UTC(1970, 0, 1, Number(hour), Number(minute), 0));
}

function toScheduleDto(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    doctorId: row.doctorId,
    weekday: row.weekday,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    maxPatients: row.maxPatients,
  };
}

/** The §20 before/after snapshot: `HH:MM` strings, not the raw Date columns. */
function snapshotOfWindow(window: WindowShape): Record<string, Prisma.InputJsonValue> {
  return {
    doctorId: window.doctorId,
    weekday: window.weekday,
    startTime: window.startTime,
    endTime: window.endTime,
    maxPatients: window.maxPatients,
  };
}

/** The §20 before/after snapshot of a stored row, times rendered as `HH:MM`. */
function snapshot(row: ScheduleRow): Record<string, Prisma.InputJsonValue> {
  return snapshotOfWindow({
    doctorId: row.doctorId,
    weekday: row.weekday,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    maxPatients: row.maxPatients,
  });
}

/**
 * The actor may act on this doctor's template: ADMIN/STAFF always, a DOCTOR
 * only their own. A PATIENT falls through to the 403 even if a future route
 * miswires the role gate — the same belt-and-braces as `requireSelfOrRole`,
 * decided here rather than trusted to middleware composition.
 */
function assertScheduleAccess(actor: ActorContext, doctorId: string): void {
  if (actor.role === $Enums.UserRole.ADMIN || actor.role === $Enums.UserRole.STAFF) {
    return;
  }
  if (actor.role === $Enums.UserRole.DOCTOR && actor.id === doctorId) {
    return;
  }
  throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
}

/**
 * The read half of every mutation: 404 on anything that is not a doctor row,
 * 409 on ARCHIVED (§5.2: no booking, schedule or profile action may touch an
 * archived doctor — the way back is UNARCHIVE, then scheduling resumes).
 */
async function loadDoctor(doctorId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: doctorId },
    select: { role: true, doctorProfile: { select: { verificationStatus: true } } },
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR || !user.doctorProfile) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  if (user.doctorProfile.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED) {
    throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived — unarchive before editing their schedule");
  }
}

async function loadSchedule(scheduleId: string): Promise<ScheduleRow> {
  const row = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!row) {
    throw new AppError(404, "SCHEDULE_NOT_FOUND", "Schedule window not found");
  }
  return row;
}

/**
 * The overlap refusal (decision 3): 422, naming the conflicting window. Half-open
 * intervals via `windowsOverlap`, so 09:00–12:00 and 12:00–15:00 coexist.
 */
async function assertNoOverlap(
  doctorId: string,
  weekday: $Enums.Weekday,
  startTime: string,
  endTime: string,
  excludeScheduleId?: string,
): Promise<void> {
  const siblings = await prisma.schedule.findMany({
    where: { doctorId, weekday, ...(excludeScheduleId !== undefined && { id: { not: excludeScheduleId } }) },
    select: { id: true, startTime: true, endTime: true },
  });

  for (const sibling of siblings) {
    const candidate = { startTime, endTime };
    const existing = { startTime: hhmm(sibling.startTime), endTime: hhmm(sibling.endTime) };
    if (windowsOverlap(candidate, existing)) {
      throw new AppError(
        422,
        "SCHEDULE_WINDOW_OVERLAP",
        `This window overlaps the existing ${existing.startTime}–${existing.endTime} window on the same weekday`,
        { conflictingScheduleId: sibling.id },
      );
    }
  }
}

/**
 * The generator, run after the commit. Never throws into the caller: a failed
 * top-up must not turn a saved template into a 500 (see the file comment).
 * The failure is logged loudly instead, and the result is null.
 */
async function materializeQuietly(doctorId: string): Promise<MaterializeStats | null> {
  try {
    return await materializeSlots({ doctorId });
  } catch (error) {
    // The window is saved either way (see the file comment); a failed top-up
    // is logged loudly here and fixable with POST /schedules/materialize.
    logger.error({ err: error, doctorId }, "post-mutation slot materialisation failed — schedule saved, slots pending");
    return null;
  }
}

export async function listSchedules(doctorId: string): Promise<ScheduleDto[]> {
  const rows = await prisma.schedule.findMany({
    where: { doctorId },
    orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toScheduleDto);
}

/**
 * Create one weekly window, then materialise the horizon for this doctor.
 *
 * The unique key's 409 (`SCHEDULE_WINDOW_EXISTS`) is what two concurrent
 * creates of the same window collapse to; the overlap 422 above it is the
 * friendlier answer for the sequential case and covers partial overlaps the
 * unique key cannot see.
 */
export async function createScheduleWindow(input: CreateScheduleInput): Promise<ScheduleMutationResult> {
  await loadDoctor(input.doctorId);
  assertScheduleAccess(input.actor, input.doctorId);
  await assertNoOverlap(input.doctorId, input.weekday, input.startTime, input.endTime);

  let created: ScheduleRow;
  try {
    created = await prisma.$transaction(async (tx) => {
      const row = await tx.schedule.create({
        data: {
          doctorId: input.doctorId,
          weekday: input.weekday,
          startTime: timeValue(input.startTime),
          endTime: timeValue(input.endTime),
          maxPatients: input.maxPatients,
        },
      });

      await writeAudit(tx, {
        action: "SCHEDULE_CREATED",
        targetType: "schedule",
        targetId: row.id,
        actor: input.actor,
        after: snapshotOfWindow({
          doctorId: input.doctorId,
          weekday: input.weekday,
          startTime: input.startTime,
          endTime: input.endTime,
          maxPatients: input.maxPatients,
        }),
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return row;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError(
        409,
        "SCHEDULE_WINDOW_EXISTS",
        "This doctor already has a window starting at that time on this weekday",
      );
    }
    throw error;
  }

  return {
    schedule: toScheduleDto(created),
    materialized: await materializeQuietly(input.doctorId),
  };
}

/**
 * Patch one window. The merged result is what gets the checks — an
 * `endTime`-only patch against a later `startTime` is invalid as a merge even
 * when it passes the schema's within-patch refine — and the same
 * transaction-then-materialise shape as create.
 */
export async function updateScheduleWindow(input: UpdateScheduleInput): Promise<ScheduleMutationResult> {
  const existing = await loadSchedule(input.scheduleId);
  assertScheduleAccess(input.actor, existing.doctorId);

  // Decision 2: capacity is §8.3 clinic configuration — a doctor may set it
  // when opening a window (create) but may not move it afterwards. Same
  // reasoning as consultationFee being admin/staff-only on PATCH.
  if (input.patch.maxPatients !== undefined && input.actor.role === $Enums.UserRole.DOCTOR) {
    throw new AppError(403, "FORBIDDEN", "Only an admin or staff member can change a window's capacity");
  }

  const merged = {
    weekday: input.patch.weekday ?? existing.weekday,
    startTime: input.patch.startTime ?? hhmm(existing.startTime),
    endTime: input.patch.endTime ?? hhmm(existing.endTime),
    maxPatients: input.patch.maxPatients ?? existing.maxPatients,
  };

  const unchanged =
    merged.weekday === existing.weekday &&
    merged.startTime === hhmm(existing.startTime) &&
    merged.endTime === hhmm(existing.endTime) &&
    merged.maxPatients === existing.maxPatients;
  if (unchanged) {
    throw new AppError(409, "NO_CHANGES", "No fields changed");
  }

  await assertNoOverlap(existing.doctorId, merged.weekday, merged.startTime, merged.endTime, existing.id);

  let updated: ScheduleRow;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const row = await tx.schedule.update({
        where: { id: existing.id },
        data: {
          weekday: merged.weekday,
          startTime: timeValue(merged.startTime),
          endTime: timeValue(merged.endTime),
          maxPatients: merged.maxPatients,
        },
      });

      await writeAudit(tx, {
        action: "SCHEDULE_UPDATED",
        targetType: "schedule",
        targetId: row.id,
        actor: input.actor,
        before: snapshot(existing),
        after: snapshot(row),
        reason: input.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return row;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError(
        409,
        "SCHEDULE_WINDOW_EXISTS",
        "This doctor already has a window starting at that time on this weekday",
      );
    }
    throw error;
  }

  return {
    schedule: toScheduleDto(updated),
    materialized: await materializeQuietly(existing.doctorId),
  };
}

/**
 * Delete one window. Existing slots are deliberately untouched (§11, see the
 * file comment); the materialise call still runs because it is harmless — the
 * deleted window no longer plans anything, and any unrelated top-up (a
 * verify/unsuspend that raced this edit) gets its slots.
 */
export async function deleteScheduleWindow(input: DeleteScheduleInput): Promise<ScheduleMutationResult> {
  const existing = await loadSchedule(input.scheduleId);
  assertScheduleAccess(input.actor, existing.doctorId);

  const deleted = await prisma.$transaction(async (tx) => {
    // Conditional delete: a concurrent update between the read above and this
    // line would otherwise be silently destroyed by a delete that snapshotted
    // the pre-update row. updatedAt is the cheapest change-detector the row has.
    const result = await tx.schedule.deleteMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
    });
    if (result.count !== 1) {
      throw new AppError(
        409,
        "SCHEDULE_CHANGED",
        "This window changed while you were editing it; reload and retry",
      );
    }

    await writeAudit(tx, {
      action: "SCHEDULE_DELETED",
      targetType: "schedule",
      targetId: existing.id,
      actor: input.actor,
      before: snapshot(existing),
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return existing;
  });

  return {
    schedule: toScheduleDto(deleted),
    materialized: await materializeQuietly(existing.doctorId),
  };
}

/**
 * The manual generator re-run (and the shape the post-verify hook uses).
 * ADMIN/STAFF-only at the route; here it just runs.
 */
export async function materializeManually(doctorId?: string): Promise<MaterializeStats> {
  if (doctorId !== undefined) {
    await loadDoctor(doctorId);
  }
  return materializeSlots(doctorId !== undefined ? { doctorId } : {});
}
