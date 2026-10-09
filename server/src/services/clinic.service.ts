import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";

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
