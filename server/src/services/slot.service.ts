import { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import type { DbClient } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { localDateTimeToUtc, utcToLocalDateTime } from "../lib/time.js";
import { windowsOverlap } from "../lib/slotPlan.js";
import {
  assertCapacityNotBelowCounters,
  assertNoSeatOrLiveHold,
} from "../lib/slotGuard.js";
import { writeAudit } from "./audit.service.js";
import { getClinicSettings } from "./clinic.service.js";
import { writeDoctorHistory } from "./doctor.service.js";
import type { SlotDto } from "../schemas/slots.js";

/**
 * plan.md §8.4 — the dated-Slot write surface, Day 16. Mirrors
 * schedule.service.ts: read the target → check the actor and the shape →
 * ONE transaction { conditional write + writeAudit + writeDoctorHistory }.
 *
 * The §8.4 guards are the product, and they are enforced INSIDE the
 * transaction against rows re-read in it (decision 3/4, §8.6 — never trust
 * the counters read outside the transaction).
 *
 * **Decision 8 — audit + DoctorHistory double-write.** Every mutation writes
 * the §20 AuditLog row (targetType `slot`, before/after snapshots, reason, ip,
 * requestId) AND a DoctorHistory entry on the owning doctor's timeline — plan
 * line 1387 explicitly records "§8.4 slot edits" there. Four action names ride
 * both surfaces: `SLOT_CREATED`, `SLOT_UPDATED` (time/date edit),
 * `SLOT_CAPACITY_CHANGE` (capacity-only edit), `SLOT_DISABLED`/`SLOT_ENABLED`.
 *
 * **The two prohibitions and their shared test (decision 3) live in
 * lib/slotGuard.ts.** Time/date edits AND disable both run
 * `assertNoSeatOrLiveHold` (loophole B3's one-predicate rule); capacity-only
 * edits skip it but run `assertCapacityNotBelowCounters` (decision 4).
 *
 * **Time duality (decision 5):** `slotDate`/`startTime`/`endTime` are the
 * clinic-local wall clock; `startAt`/`endAt` are the UTC instants every
 * comparison reads, recomputed on a time edit through the single
 * `localDateTimeToUtc` with the Clinic row's timezone (§3.2). Capacity-only
 * edits never touch `startAt`/`endAt`.
 *
 * **Roles (decision 1):** ADMIN/STAFF only — a DOCTOR's availability tool is
 * Day 18's `DoctorUnavailability`, not slot mutation. Re-checked in the service
 * even though the route gates (the double-enforcement rule).
 *
 * **Interplay with the generator (decision 6):** the `(doctorId, slotDate,
 * startTime)` unique key collapses a manual create racing the generator to a
 * 409; create is restricted to the booking horizon (a date beyond it is
 * invisible to every reader — making one is a mistake, not a feature).
 */

/** What every mutation here contributes to its §20 audit + §5.2 history rows. */
export interface SlotMutationInput {
  readonly actor: { readonly id: string; readonly role: $Enums.UserRole; readonly name: string };
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

export interface CreateSlotInput extends SlotMutationInput {
  readonly doctorId: string;
  readonly slotDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
  readonly reason?: string | undefined;
}

export interface UpdateSlotInput extends SlotMutationInput {
  readonly slotId: string;
  readonly patch: {
    readonly slotDate?: string | undefined;
    readonly startTime?: string | undefined;
    readonly endTime?: string | undefined;
    readonly maxPatients?: number | undefined;
  };
  readonly reason: string;
}

export interface DisableSlotInput extends SlotMutationInput {
  readonly slotId: string;
  readonly reason: string;
  readonly enabled: boolean;
}

/** The slot row as the service reads it — enough for every guard and snapshot. */
interface SlotRow {
  readonly id: string;
  readonly doctorId: string;
  readonly slotDate: Date;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly maxPatients: number;
  readonly bookedCount: number;
  readonly heldCount: number;
  readonly isDisabled: boolean;
  readonly disabledReason: string | null;
  readonly updatedAt: Date;
}

/** `@db.Time(0)` read back as a 1970-01-01 Date → the `HH:MM` clients and audits speak. */
function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** `@db.Time(0)` write value: UTC-anchored 1970-01-01. */
function timeValue(time: string): Date {
  const [hour = "0", minute = "0"] = time.split(":");
  return new Date(Date.UTC(1970, 0, 1, Number(hour), Number(minute), 0));
}

/** `@db.Date` write value: the clinic-local calendar date as a UTC midnight. */
function dateValue(date: string): Date {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function toSlotDto(row: SlotRow): SlotDto {
  return {
    id: row.id,
    doctorId: row.doctorId,
    slotDate: row.slotDate.toISOString().slice(0, 10),
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    maxPatients: row.maxPatients,
    bookedCount: row.bookedCount,
    heldCount: row.heldCount,
    isDisabled: row.isDisabled,
    disabledReason: row.disabledReason,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
  };
}

/** The §20 before/after snapshot: the fields staff see, not the raw Date columns. */
function snapshotOfSlot(row: SlotRow): Record<string, Prisma.InputJsonValue | null> {
  return {
    doctorId: row.doctorId,
    slotDate: row.slotDate.toISOString().slice(0, 10),
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    maxPatients: row.maxPatients,
    bookedCount: row.bookedCount,
    heldCount: row.heldCount,
    isDisabled: row.isDisabled,
    disabledReason: row.disabledReason,
  };
}

async function loadSlot(slotId: string): Promise<SlotRow> {
  const row = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!row) {
    throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
  }
  return row;
}

/** §5.2: slots belong to a doctor that must still be one and not archived. */
async function loadDoctor(doctorId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: doctorId },
    select: { role: true, doctorProfile: { select: { verificationStatus: true } } },
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR || !user.doctorProfile) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  if (user.doctorProfile.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED) {
    throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived — unarchive before editing their slots");
  }
}

/** Decision 1: ADMIN/STAFF only; a DOCTOR may never manage slots. */
function assertSlotsActor(actor: SlotMutationInput["actor"]): void {
  if (actor.role !== $Enums.UserRole.ADMIN && actor.role !== $Enums.UserRole.STAFF) {
    throw new AppError(403, "FORBIDDEN", "Only an admin or staff member can manage slots");
  }
}

/** The inclusive booking horizon `[today, today + bookingHorizonDays]` as `YYYY-MM-DD`. */
async function horizonBounds(): Promise<{ min: string; max: string }> {
  const clinic = await getClinicSettings();
  const today = utcToLocalDateTime(new Date(), clinic.timezone).date;
  const asUtc = dateValue(today);
  const maxDate = new Date(
    Date.UTC(asUtc.getUTCFullYear(), asUtc.getUTCMonth(), asUtc.getUTCDate() + clinic.bookingHorizonDays),
  )
    .toISOString()
    .slice(0, 10);
  return { min: today, max: maxDate };
}

/** The seat-or-hold inputs for one slot, re-read inside `db`. */
async function loadSeatHoldInputs(
  db: DbClient,
  slotId: string,
): Promise<{
  readonly appointments: readonly { readonly status: $Enums.AppointmentStatus; readonly slotEndAt: Date }[];
  readonly holds: readonly { readonly releasedAt: Date | null; readonly expiresAt: Date }[];
}> {
  const [appointments, holds] = await Promise.all([
    db.appointment.findMany({
      where: { slotId },
      select: { status: true, slot: { select: { endAt: true } } },
    }),
    db.seatHold.findMany({
      where: { slotId },
      select: { releasedAt: true, expiresAt: true },
    }),
  ]);
  return {
    appointments: appointments.map((appointment) => ({
      status: appointment.status,
      slotEndAt: appointment.slot.endAt,
    })),
    holds,
  };
}

/**
 * The overlap refusal (decision 5): on the same doctor and clinic-local date
 * another slot cannot share a minute. Half-open via `windowsOverlap`, so
 * adjacent windows coexist; excludes the slot being edited.
 */
async function assertNoSlotOverlap(
  db: DbClient,
  doctorId: string,
  slotDate: string,
  startTime: string,
  endTime: string,
  excludeSlotId?: string,
): Promise<void> {
  const candidates = await db.slot.findMany({
    where: {
      doctorId,
      slotDate: dateValue(slotDate),
      ...(excludeSlotId !== undefined && { id: { not: excludeSlotId } }),
    },
    select: { startTime: true, endTime: true },
  });

  for (const candidate of candidates) {
    const existing = { startTime: hhmm(candidate.startTime), endTime: hhmm(candidate.endTime) };
    if (windowsOverlap({ startTime, endTime }, existing)) {
      throw new AppError(
        422,
        "SLOT_OVERLAP",
        `This slot overlaps the existing ${existing.startTime}–${existing.endTime} slot for the same doctor on ${slotDate}`,
      );
    }
  }
}

/** GET /slots — the management list, scoped to one doctor (and day). */
export async function listSlots(doctorId: string, slotDate?: string): Promise<SlotDto[]> {
  await loadDoctor(doctorId);
  const rows = await prisma.slot.findMany({
    where: { doctorId, ...(slotDate !== undefined && { slotDate: dateValue(slotDate) }) },
    orderBy: [{ slotDate: "asc" }, { startTime: "asc" }],
  });
  return rows.map(toSlotDto);
}

/**
 * POST /slots — one manual dated slot, the exception path staff use when the
 * template does not produce a slot they need on a specific date (§8.2's "slot
 * availability" is configurable). Reason is optional on create (decision 2).
 */
export async function createSlot(input: CreateSlotInput): Promise<SlotDto> {
  assertSlotsActor(input.actor);
  await loadDoctor(input.doctorId);

  const bounds = await horizonBounds();
  if (input.slotDate < bounds.min || input.slotDate > bounds.max) {
    throw new AppError(
      422,
      "SLOT_OUTSIDE_HORIZON",
      `Slot date ${input.slotDate} is outside the booking horizon (${bounds.min} to ${bounds.max})`,
    );
  }

  const clinic = await getClinicSettings();

  let created: SlotRow;
  try {
    created = await prisma.$transaction(async (tx) => {
      await assertNoSlotOverlap(tx, input.doctorId, input.slotDate, input.startTime, input.endTime);

      const row = await tx.slot.create({
        data: {
          doctorId: input.doctorId,
          slotDate: dateValue(input.slotDate),
          startTime: timeValue(input.startTime),
          endTime: timeValue(input.endTime),
          startAt: localDateTimeToUtc({ date: input.slotDate, time: input.startTime }, clinic.timezone),
          endAt: localDateTimeToUtc({ date: input.slotDate, time: input.endTime }, clinic.timezone),
          maxPatients: input.maxPatients,
        },
      });

      await writeAudit(tx, {
        action: "SLOT_CREATED",
        targetType: "slot",
        targetId: row.id,
        actor: input.actor,
        after: {
          slotDate: input.slotDate,
          startTime: input.startTime,
          endTime: input.endTime,
          maxPatients: input.maxPatients,
        },
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      await writeDoctorHistory(tx, {
        doctorId: input.doctorId,
        eventType: "SLOT_CREATED",
        actor: input.actor,
        metadata: {
          slotId: row.id,
          slotDate: input.slotDate,
          startTime: input.startTime,
          endTime: input.endTime,
          maxPatients: input.maxPatients,
        },
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return row as SlotRow;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError(
        409,
        "SLOT_EXISTS",
        `A slot already exists for this doctor at ${input.startTime} on ${input.slotDate}`,
      );
    }
    throw error;
  }

  return toSlotDto(created);
}

/**
 * PATCH /slots/:id — the §8.4 edit surface. Two kinds of edit, one verb:
 *
 * - Any of `slotDate`/`startTime`/`endTime` present → a *time edit*: the shared
 *   seat-or-hold guard refuses it (409 SLOT_HELD, decision 3), the merged result
 *   is overlap-checked (decision 5), and `startAt`/`endAt` are recomputed.
 * - Only `maxPatients` present → a *capacity edit*: NO seat-or-hold test
 *   (decision 3), only `assertCapacityNotBelowCounters` (decision 4), and the
 *   times are never touched.
 * - Reason is mandatory on every edit (schema enforces presence; the service
 *   re-checks the merged window end-after-start).
 */
export async function updateSlot(input: UpdateSlotInput): Promise<SlotDto> {
  assertSlotsActor(input.actor);
  const existing = await loadSlot(input.slotId);

  const isTimeEdit =
    input.patch.slotDate !== undefined ||
    input.patch.startTime !== undefined ||
    input.patch.endTime !== undefined;

  const merged = {
    slotDate: input.patch.slotDate ?? existing.slotDate.toISOString().slice(0, 10),
    startTime: input.patch.startTime ?? hhmm(existing.startTime),
    endTime: input.patch.endTime ?? hhmm(existing.endTime),
    maxPatients: input.patch.maxPatients ?? existing.maxPatients,
  };

  // Decision 5 (§8.4): the merged window cannot run overnight even when the
  // patch alone passed (an endTime-only patch against a later startTime is
  // invalid as a merge — the schedules.ts precedent).
  if (merged.endTime <= merged.startTime) {
    throw new AppError(422, "INVALID_WINDOW", "endTime must be after startTime (windows cannot run overnight)");
  }

  const unchanged =
    merged.slotDate === existing.slotDate.toISOString().slice(0, 10) &&
    merged.startTime === hhmm(existing.startTime) &&
    merged.endTime === hhmm(existing.endTime) &&
    merged.maxPatients === existing.maxPatients;
  if (unchanged) {
    throw new AppError(409, "NO_CHANGES", "No fields changed");
  }

  const clinic = await getClinicSettings();

  let updated: SlotRow;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction so the guards see state that coexisted
      // with this write (§8.6 — never trust the counters read outside it).
      const row = (await tx.slot.findUnique({ where: { id: existing.id } })) as SlotRow;
      if (!row) {
        throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
      }

      if (isTimeEdit) {
        const inputs = await loadSeatHoldInputs(tx, existing.id);
        assertNoSeatOrLiveHold(inputs.appointments, inputs.holds, new Date());
      }

      assertCapacityNotBelowCounters(merged.maxPatients, row.bookedCount, row.heldCount);

      if (isTimeEdit) {
        await assertNoSlotOverlap(tx, row.doctorId, merged.slotDate, merged.startTime, merged.endTime, existing.id);
      }

      const updatedRow = await tx.slot.update({
        where: { id: existing.id },
        data: {
          ...(input.patch.slotDate !== undefined && { slotDate: dateValue(merged.slotDate) }),
          ...(input.patch.startTime !== undefined && { startTime: timeValue(merged.startTime) }),
          ...(input.patch.endTime !== undefined && { endTime: timeValue(merged.endTime) }),
          // §8.4: capacity-only edits never touch the times — startAt/endAt
          // stay put unless the schedule window itself moved.
          ...(isTimeEdit && {
            startAt: localDateTimeToUtc({ date: merged.slotDate, time: merged.startTime }, clinic.timezone),
            endAt: localDateTimeToUtc({ date: merged.slotDate, time: merged.endTime }, clinic.timezone),
          }),
          ...(input.patch.maxPatients !== undefined && { maxPatients: merged.maxPatients }),
        },
      });

      await writeAudit(tx, {
        action: isTimeEdit ? "SLOT_UPDATED" : "SLOT_CAPACITY_CHANGE",
        targetType: "slot",
        targetId: updatedRow.id,
        actor: input.actor,
        before: snapshotOfSlot(row),
        after: snapshotOfSlot(updatedRow as SlotRow),
        reason: input.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: isTimeEdit ? "SLOT_UPDATED" : "SLOT_CAPACITY_CHANGE",
        actor: input.actor,
        metadata: {
          slotId: updatedRow.id,
          before: isTimeEdit
            ? {
                slotDate: row.slotDate.toISOString().slice(0, 10),
                startTime: hhmm(row.startTime),
                endTime: hhmm(row.endTime),
              }
            : { maxPatients: row.maxPatients },
          after: isTimeEdit
            ? {
                slotDate: merged.slotDate,
                startTime: merged.startTime,
                endTime: merged.endTime,
              }
            : { maxPatients: merged.maxPatients },
        },
        reason: input.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return updatedRow as SlotRow;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new AppError(
        409,
        "SLOT_EXISTS",
        `A slot already exists for this doctor at ${merged.startTime} on ${merged.slotDate}`,
      );
    }
    throw error;
  }

  return toSlotDto(updated);
}

/**
 * POST /slots/:id/disable and /enable — the audited availability split
 * (decision 7). Disabling runs the SAME seat-or-hold guard as a time edit
 * (§8.4: "disabling or removing a slot while it holds an active booking or a
 * live hold → rejected"); re-enabling is always allowed, both with a mandatory
 * reason. No hard DELETE route — disable is the removal semantics.
 */
export async function setSlotDisabled(input: DisableSlotInput): Promise<SlotDto> {
  assertSlotsActor(input.actor);
  const existing = await loadSlot(input.slotId);

  // `input.enabled` is the goal ("should this slot be enabled now?"), so the
  // target row state is its negation: /disable (enabled=false) → disabled=true,
  // /enable (enabled=true) → disabled=false.
  const targetIsDisabled = !input.enabled;
  if (existing.isDisabled === targetIsDisabled) {
    // A no-op write would still manufacture an audit row claiming a change
    // that did not happen. Fail instead.
    throw new AppError(409, "NO_CHANGES", `Slot is already ${targetIsDisabled ? "disabled" : "enabled"}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = (await tx.slot.findUnique({ where: { id: existing.id } })) as SlotRow;
    if (!row) {
      throw new AppError(404, "SLOT_NOT_FOUND", "Slot not found");
    }

    if (!input.enabled) {
      const inputs = await loadSeatHoldInputs(tx, existing.id);
      assertNoSeatOrLiveHold(inputs.appointments, inputs.holds, new Date());
    }

    const updatedRow = await tx.slot.update({
      where: { id: existing.id },
      data: {
        isDisabled: targetIsDisabled,
        ...(input.enabled ? { disabledReason: null } : { disabledReason: input.reason }),
      },
    });

    await writeAudit(tx, {
      action: input.enabled ? "SLOT_ENABLED" : "SLOT_DISABLED",
      targetType: "slot",
      targetId: updatedRow.id,
      actor: input.actor,
      before: snapshotOfSlot(row),
      after: snapshotOfSlot(updatedRow as SlotRow),
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: row.doctorId,
      eventType: input.enabled ? "SLOT_ENABLED" : "SLOT_DISABLED",
      actor: input.actor,
      metadata: { slotId: updatedRow.id },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return updatedRow as SlotRow;
  });

  return toSlotDto(updated);
}