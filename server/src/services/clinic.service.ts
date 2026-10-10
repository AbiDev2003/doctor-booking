import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { writeAudit } from "./audit.service.js";
import { materializeSlots } from "./slotGeneration.service.js";
import type { ActorContext } from "./doctor.service.js";

/**
 * plan.md §3.2 — the single Clinic config row, read through one helper, Day 15.
 *
 * The schema enforces one row (`@relation` targets and the seed's fixed id),
 * and every tunable in the system lives there rather than as a constant in
 * code. Before Day 15 the only readers were the public clinic endpoint and the
 * seed; from Day 15 the slot generator and the doctor queue read it too, and
 * the honest shape of that growth is one accessor rather than three
 * `findFirst`s that can drift apart the day the schema gains a second row.
 *
 * **`timezone` is the runtime authority for wall-clock conversions (§3.2).**
 * `APP_TIMEZONE` bootstraps this row at seed time and remains required at boot
 * so a fresh install cannot come up without a zone, but from Day 15 nothing in
 * the request path reads it: the generator, the queue and every future
 * conversion read `clinic.timezone` here. A clinic that relocates updates one
 * row; no redeploy, no stale env.
 *
 * A missing row is a 500, not a 404: the seed always creates it, so its absence
 * means the database was never seeded — a deployment fault the caller cannot
 * fix and must not mistake for "clinic not found".
 */
export interface ClinicSettings {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly defaultConsultationFee: number;
  readonly bookingHorizonDays: number;
  readonly cancelCutoffMinutes: number;
  readonly holdDurationMinutes: number;
  readonly minLeadMinutes: number;
  readonly reminderLeadMinutes: number;
  readonly maxActiveBookingsPerPatient: number;
}

export async function getClinicSettings(): Promise<ClinicSettings> {
  const clinic = await prisma.clinic.findFirst({
    select: {
      id: true,
      name: true,
      timezone: true,
      currency: true,
      defaultConsultationFee: true,
      bookingHorizonDays: true,
      cancelCutoffMinutes: true,
      holdDurationMinutes: true,
      minLeadMinutes: true,
      reminderLeadMinutes: true,
      maxActiveBookingsPerPatient: true,
    },
  });

  if (!clinic) {
    throw new AppError(500, "CLINIC_NOT_CONFIGURED", "Clinic configuration is missing — run the database seed");
  }

  return clinic;
}

/** The §3.2/decision 9 surface: exactly the six scheduling tunables. */
export interface ClinicSettingsPatch {
  readonly bookingHorizonDays?: number | undefined;
  readonly cancelCutoffMinutes?: number | undefined;
  readonly holdDurationMinutes?: number | undefined;
  readonly minLeadMinutes?: number | undefined;
  readonly reminderLeadMinutes?: number | undefined;
  readonly maxActiveBookingsPerPatient?: number | undefined;
}

/** The §20 before/after snapshot of the tunables, cast to JSON-friendly objects. */
type SchedulingTunables = Pick<
  ClinicSettings,
  "bookingHorizonDays" | "cancelCutoffMinutes" | "holdDurationMinutes" | "minLeadMinutes" | "reminderLeadMinutes" | "maxActiveBookingsPerPatient"
>;

function snapshotTunables(settings: SchedulingTunables): Record<string, number> {
  return {
    bookingHorizonDays: settings.bookingHorizonDays,
    cancelCutoffMinutes: settings.cancelCutoffMinutes,
    holdDurationMinutes: settings.holdDurationMinutes,
    minLeadMinutes: settings.minLeadMinutes,
    reminderLeadMinutes: settings.reminderLeadMinutes,
    maxActiveBookingsPerPatient: settings.maxActiveBookingsPerPatient,
  };
}

export interface UpdateClinicSettingsInput {
  readonly actor: ActorContext;
  readonly patch: ClinicSettingsPatch;
  readonly reason?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * PATCH /api/v1/clinics/settings (decision 9) — ADMIN-only, updating one or
 * more of the six scheduling tunables, always audited as
 * `CLINIC_SETTINGS_UPDATED` with before/after snapshots of exactly those six.
 * The reason is OPTIONAL here (unlike slot edits): the audit snapshot already
 * says what changed, and a staff member tightening the cancel cutoff should
 * not be forced to fabricate prose. `timezone` and friends stay out of reach
 * of this function by construction — there is no field for them to receive.
 *
 * When `bookingHorizonDays` changes, `materializeSlots()` re-runs AFTER commit
 * (decision 10): a widened horizon tops up idempotently; a narrowed one writes
 * nothing new and leaves the now-far-future slots for the Day 17 read model /
 * Day 19 booking-horizon check to keep invisible. The audit is written once,
 * in the same transaction as the row (the `writeAudit` contract) — never once
 * per materialisation.
 */
export async function updateClinicSettings(input: UpdateClinicSettingsInput): Promise<ClinicSettings> {
  // Decision 9's ADMIN-only rule, re-enforced in the service (Day 12's
  // double-enforcement: a route wired in the wrong order must not open it up).
  if (input.actor.role !== $Enums.UserRole.ADMIN) {
    throw new AppError(403, "FORBIDDEN", "Only an admin can change clinic settings");
  }

  const before = await getClinicSettings();

  const unchanged = Object.entries(input.patch).every(([key, value]) => before[key as keyof ClinicSettingsPatch] === value);
  if (unchanged) {
    // A no-op write would still manufacture an audit row claiming a change
    // that did not happen. Fail instead.
    throw new AppError(409, "NO_CHANGES", "No settings changed");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.clinic.findFirst({
      select: { id: true, bookingHorizonDays: true, cancelCutoffMinutes: true, holdDurationMinutes: true, minLeadMinutes: true, reminderLeadMinutes: true, maxActiveBookingsPerPatient: true },
    });
    if (!row) {
      throw new AppError(500, "CLINIC_NOT_CONFIGURED", "Clinic configuration is missing — run the database seed");
    }

    const written = await tx.clinic.update({
      where: { id: row.id },
      data: {
        ...(input.patch.bookingHorizonDays !== undefined && { bookingHorizonDays: input.patch.bookingHorizonDays }),
        ...(input.patch.cancelCutoffMinutes !== undefined && { cancelCutoffMinutes: input.patch.cancelCutoffMinutes }),
        ...(input.patch.holdDurationMinutes !== undefined && { holdDurationMinutes: input.patch.holdDurationMinutes }),
        ...(input.patch.minLeadMinutes !== undefined && { minLeadMinutes: input.patch.minLeadMinutes }),
        ...(input.patch.reminderLeadMinutes !== undefined && { reminderLeadMinutes: input.patch.reminderLeadMinutes }),
        ...(input.patch.maxActiveBookingsPerPatient !== undefined && { maxActiveBookingsPerPatient: input.patch.maxActiveBookingsPerPatient }),
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        currency: true,
        defaultConsultationFee: true,
        bookingHorizonDays: true,
        cancelCutoffMinutes: true,
        holdDurationMinutes: true,
        minLeadMinutes: true,
        reminderLeadMinutes: true,
        maxActiveBookingsPerPatient: true,
      },
    });

    await writeAudit(tx, {
      action: "CLINIC_SETTINGS_UPDATED",
      targetType: "clinic",
      targetId: written.id,
      actor: input.actor,
      before: snapshotTunables(row),
      after: snapshotTunables(written),
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return written;
  });

  // Decision 10: widening the horizon must stock it — AFTER the audit commits.
  // Narrowing writes nothing (idempotent), which is the point of the re-run.
  if (input.patch.bookingHorizonDays !== undefined && input.patch.bookingHorizonDays !== before.bookingHorizonDays) {
    await materializeSlots();
  }

  return updated;
}
