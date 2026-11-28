import { $Enums } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import { AppError } from "../../lib/appError.js";
import { logger } from "../../lib/logger.js";
import { getClinicSettings } from "../clinic.service.js";
import { localDateTimeToUtc } from "../../lib/time.js";
import { assertValidDisruptionWindow, selectOnlyConfirmed } from "../../lib/unavailability.js";
import { windowsOverlap } from "../../lib/slotPlan.js";
import { writeAudit } from "../audit.service.js";
import { writeDoctorHistory } from "../doctors/doctor.service.js";
import type { ActorContext, RequestMeta } from "../doctors/doctor.service.js";
import { applyUnavailabilityCascade } from "../appointments/appointmentCascade.service.js";
import { materializeSlots } from "../slots/slotGeneration.service.js";
import {
  doctorScheduleChangeDecidedEmail,
  doctorScheduleChangeRequestedEmail,
} from "../../lib/emailTemplates.js";
import {
  dispatchNotificationInBackground,
  queueNotification,
} from "../notifications/notification.service.js";

/**
 * §11/§12 doctor self-service approval seam.
 *
 * A doctor's schedule and time-off edits are stored as proposals. The live
 * template, slots, unavailability rows and bookings are NOT touched until an
 * ADMIN approves. Multiple proposals may be pending; a 5-minute submission
 * cooldown and pending-conflict checks stop spam without blocking legitimate
 * independent changes. Review re-checks the live state inside the same
 * transaction that claims the request.
 */
const T = $Enums.DoctorScheduleChangeType;
const S = $Enums.DoctorScheduleChangeStatus;

export const DOCTOR_SCHEDULE_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

const ACTION_LABELS: Record<$Enums.DoctorScheduleChangeType, string> = {
  [T.WINDOW_CREATE]: "Add weekly window",
  [T.WINDOW_UPDATE]: "Edit weekly window",
  [T.WINDOW_DELETE]: "Delete weekly window",
  [T.UNAVAILABILITY_CREATE]: "Mark time off",
  [T.UNAVAILABILITY_DELETE]: "Remove time off",
};

const SUBMISSION_NOTES: Record<$Enums.DoctorScheduleChangeType, string> = {
  [T.WINDOW_CREATE]: "The current weekly template, generated slots and bookings stay unchanged until approval.",
  [T.WINDOW_UPDATE]: "Existing generated slots and their bookings stay unchanged until approval.",
  [T.WINDOW_DELETE]: "Existing slots and bookings stay unchanged until approval; the window only stops future generation.",
  [T.UNAVAILABILITY_CREATE]: "No slots are hidden and no patients are flagged until approval.",
  [T.UNAVAILABILITY_DELETE]: "The time-off window stays active until approval.",
};

interface WindowShape {
  readonly weekday: $Enums.Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients?: number;
}

interface UnavailabilityShape {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

interface LoadedDoctor {
  readonly fullName: string;
  readonly email: string | null;
}

interface SubmitInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly type: $Enums.DoctorScheduleChangeType;
  readonly payload: Prisma.InputJsonObject;
  readonly details: readonly string[];
  readonly reason: string;
  readonly scheduleId?: string | undefined;
  readonly unavailabilityId?: string | undefined;
  readonly previousValues?: Prisma.InputJsonObject | undefined;
  readonly affectedPreview?: number | undefined;
}

export interface ScheduleChangeSubmissionResult {
  readonly message: string;
  readonly scheduleRequest: { readonly id: string; readonly status: $Enums.DoctorScheduleChangeStatus };
}

export interface DoctorScheduleChangeRequestDto {
  readonly id: string;
  readonly doctorId: string;
  readonly doctorName: string;
  readonly doctorEmail: string | null;
  readonly doctorPhone: string | null;
  readonly type: $Enums.DoctorScheduleChangeType;
  readonly status: $Enums.DoctorScheduleChangeStatus;
  readonly details: string[];
  readonly reason: string;
  readonly affectedPreview: number | null;
  readonly requestedByName: string;
  readonly requestedAt: string;
  readonly reviewedByName: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
}

export interface ReviewScheduleChangeInput extends RequestMeta {
  readonly actor: ActorContext;
  /** The row being reviewed. `requestId` from RequestMeta stays the trace id. */
  readonly scheduleRequestId: string;
  readonly reviewNote?: string | undefined;
}

export interface ReviewScheduleChangeResult {
  readonly message: string;
  readonly status: $Enums.DoctorScheduleChangeStatus;
}

function assertDoctorSelf(actor: ActorContext, doctorId: string): void {
  if (actor.role !== $Enums.UserRole.DOCTOR || actor.id !== doctorId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
}

function assertAdminReviewer(actor: ActorContext): void {
  if (actor.role !== $Enums.UserRole.ADMIN) {
    throw new AppError(403, "FORBIDDEN", "Only an admin can review schedule changes");
  }
}

async function loadWritableDoctor(client: DbClient, doctorId: string): Promise<LoadedDoctor> {
  const user = await client.user.findUnique({
    where: { id: doctorId },
    select: {
      role: true,
      fullName: true,
      email: true,
      doctorProfile: { select: { verificationStatus: true } },
    },
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR || user.doctorProfile === null) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  if (user.doctorProfile.verificationStatus === $Enums.DoctorVerificationStatus.ARCHIVED) {
    throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived — unarchive before changing their schedule");
  }
  if (user.doctorProfile.verificationStatus === $Enums.DoctorVerificationStatus.REJECTED) {
    throw new AppError(409, "DOCTOR_REJECTED", "This doctor was rejected and cannot be scheduled");
  }
  return { fullName: user.fullName, email: user.email };
}

async function assertCooldown(client: DbClient, requestedById: string, now = new Date()): Promise<void> {
  const last = await client.doctorScheduleChangeRequest.findFirst({
    where: { requestedById },
    orderBy: { requestedAt: "desc" },
    select: { requestedAt: true },
  });
  if (last === null) return;

  const elapsed = now.getTime() - last.requestedAt.getTime();
  if (elapsed >= DOCTOR_SCHEDULE_REQUEST_COOLDOWN_MS) return;

  const retryAfterSeconds = Math.ceil((DOCTOR_SCHEDULE_REQUEST_COOLDOWN_MS - elapsed) / 1000);
  throw new AppError(
    429,
    "SCHEDULE_REQUEST_TOO_SOON",
    `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} before submitting another schedule change.`,
    { retryAfterSeconds },
  );
}

function hhmm(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Prisma's JSON input types have no index signature on plain interfaces. */
function jsonInput(value: object): Prisma.InputJsonObject {
  return value as unknown as Prisma.InputJsonObject;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function readWindow(value: unknown): WindowShape | null {
  const record = asRecord(value);
  const weekday = asString(record.weekday);
  const startTime = asString(record.startTime);
  const endTime = asString(record.endTime);
  if (weekday === null || startTime === null || endTime === null) return null;
  const maxPatients = asNumber(record.maxPatients);
  return {
    weekday: weekday as $Enums.Weekday,
    startTime,
    endTime,
    ...(maxPatients !== null && { maxPatients }),
  };
}

function readUnavailability(value: unknown): UnavailabilityShape | null {
  const record = asRecord(value);
  const date = asString(record.date);
  const startTime = asString(record.startTime);
  const endTime = asString(record.endTime);
  const startText = asString(record.startAt);
  const endText = asString(record.endAt);
  if (date === null || startTime === null || endTime === null || startText === null || endText === null) {
    return null;
  }
  const startAt = new Date(startText);
  const endAt = new Date(endText);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return { date, startTime, endTime, startAt, endAt };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function windowsConflict(a: WindowShape, b: WindowShape): boolean {
  return a.weekday === b.weekday && windowsOverlap(a, b);
}

function intervalsConflict(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

interface PendingRow {
  readonly type: $Enums.DoctorScheduleChangeType;
  readonly scheduleId: string | null;
  readonly unavailabilityId: string | null;
  readonly payload: Prisma.JsonValue;
}

function assertNoPendingConflict(pending: readonly PendingRow[], input: SubmitInput): void {
  const candidateWindow = readWindow(input.payload);
  const candidateUnavailability = readUnavailability(input.payload);

  for (const row of pending) {
    if (
      (input.scheduleId !== undefined && row.scheduleId === input.scheduleId) ||
      (input.unavailabilityId !== undefined && row.unavailabilityId === input.unavailabilityId)
    ) {
      throw new AppError(
        409,
        "SCHEDULE_CHANGE_PENDING",
        "Another change request is already pending for this schedule or time-off window.",
      );
    }

    if (candidateWindow !== null) {
      const otherWindow = readWindow(row.payload);
      if (
        otherWindow !== null &&
        windowsConflict(candidateWindow, otherWindow) &&
        (input.type !== T.WINDOW_DELETE && row.type !== T.WINDOW_DELETE)
      ) {
        throw new AppError(
          409,
          "SCHEDULE_CHANGE_CONFLICT",
          "A pending change request already covers this weekday and time.",
        );
      }
    }

    if (candidateUnavailability !== null && row.type === T.UNAVAILABILITY_CREATE) {
      const other = readUnavailability(row.payload);
      if (
        other !== null &&
        intervalsConflict(candidateUnavailability.startAt, candidateUnavailability.endAt, other.startAt, other.endAt)
      ) {
        throw new AppError(
          409,
          "SCHEDULE_CHANGE_CONFLICT",
          "A pending time-off request already overlaps this period.",
        );
      }
    }
  }
}

async function loadPendingRows(client: DbClient, doctorId: string): Promise<PendingRow[]> {
  return client.doctorScheduleChangeRequest.findMany({
    where: { doctorId, status: S.PENDING },
    select: { type: true, scheduleId: true, unavailabilityId: true, payload: true },
  });
}

async function assertNoScheduleOverlap(
  client: DbClient,
  doctorId: string,
  window: WindowShape,
  excludeScheduleId?: string,
): Promise<void> {
  const rows = await client.schedule.findMany({
    where: {
      doctorId,
      weekday: window.weekday as $Enums.Weekday,
      ...(excludeScheduleId !== undefined && { id: { not: excludeScheduleId } }),
    },
    select: { id: true, startTime: true, endTime: true },
  });
  for (const row of rows) {
    if (
      windowsOverlap(window, {
        startTime: hhmm(row.startTime),
        endTime: hhmm(row.endTime),
      })
    ) {
      throw new AppError(
        422,
        "SCHEDULE_WINDOW_OVERLAP",
        `This window overlaps the existing ${hhmm(row.startTime)}–${hhmm(row.endTime)} window on the same weekday`,
      );
    }
  }
}

async function loadScheduleRow(client: DbClient, scheduleId: string) {
  const row = await client.schedule.findUnique({ where: { id: scheduleId } });
  if (row === null) throw new AppError(404, "SCHEDULE_NOT_FOUND", "Schedule window not found");
  return row;
}

function assertSameUpdatedAt(row: { updatedAt: Date }, previousValues: unknown): void {
  const recorded = asRecord(previousValues).updatedAt;
  if (typeof recorded !== "string") return;
  const parsed = new Date(recorded);
  if (!Number.isNaN(parsed.getTime()) && parsed.getTime() !== row.updatedAt.getTime()) {
    throw new AppError(409, "SCHEDULE_CHANGED", "This window changed while the request was pending; reload and retry");
  }
}

async function adminRecipients(client: DbClient): Promise<{ email: string; fullName: string }[]> {
  const admins = await client.user.findMany({
    where: { role: $Enums.UserRole.ADMIN, isDeactivated: false, email: { not: null } },
    select: { email: true, fullName: true },
  });
  const recipients = admins
    .filter((admin): admin is { email: string; fullName: string } =>
      typeof admin.email === "string" && admin.email.trim().length > 0,
    )
    .map((admin) => ({ email: admin.email, fullName: admin.fullName }));
  if (recipients.length === 0 && config.CLINIC_OWNER_EMAIL !== undefined) {
    recipients.push({
      email: config.CLINIC_OWNER_EMAIL,
      fullName: config.CLINIC_OWNER_NAME ?? "Clinic administrator",
    });
  }
  return recipients;
}

async function submit(input: SubmitInput): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  const doctor = await loadWritableDoctor(prisma, input.doctorId);
  await assertCooldown(prisma, input.actor.id);
  await assertNoPendingConflict(await loadPendingRows(prisma, input.doctorId), input);

  const queued: { notificationId: string; email: string; fullName: string }[] = [];
  let requestId = "";

  await prisma.$transaction(async (tx) => {
    await loadWritableDoctor(tx, input.doctorId);
    await assertCooldown(tx, input.actor.id);
    await assertNoPendingConflict(await loadPendingRows(tx, input.doctorId), input);

    const request = await tx.doctorScheduleChangeRequest.create({
      data: {
        doctorId: input.doctorId,
        type: input.type,
        status: S.PENDING,
        scheduleId: input.scheduleId ?? null,
        unavailabilityId: input.unavailabilityId ?? null,
        payload: input.payload,
        previousValues: input.previousValues ?? Prisma.JsonNull,
        details: input.details as Prisma.InputJsonValue,
        affectedPreview: input.affectedPreview ?? null,
        reason: input.reason,
        requestedById: input.actor.id,
        requestedByName: input.actor.name,
      },
      select: { id: true },
    });
    requestId = request.id;

    for (const admin of await adminRecipients(tx)) {
      const notification = await queueNotification(tx, {
        type: $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_REQUESTED,
        recipient: admin.email,
      });
      queued.push({ notificationId: notification.id, email: admin.email, fullName: admin.fullName });
    }

    await writeAudit(tx, {
      action: "DOCTOR_SCHEDULE_CHANGE_REQUESTED",
      targetType: "doctor_schedule_change_request",
      targetId: request.id,
      actor: input.actor,
      before: input.previousValues,
      after: { type: input.type, payload: input.payload, details: input.details },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "SCHEDULE_CHANGE_REQUESTED",
      actor: input.actor,
      metadata: { requestId: request.id, type: input.type, details: input.details },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });

  const link =
    `${config.CLIENT_URL.replace(/\/$/, "")}/admin/schedule-requests?request=${encodeURIComponent(requestId)}`;

  for (const admin of queued) {
    dispatchNotificationInBackground(
      admin.notificationId,
      doctorScheduleChangeRequestedEmail({
        fullName: admin.fullName,
        doctorName: doctor.fullName,
        doctorEmail: doctor.email ?? "Not on file",
        action: ACTION_LABELS[input.type],
        details: input.details,
        reason: input.reason,
        requestId,
        note: SUBMISSION_NOTES[input.type],
        link,
      }),
    );
  }

  return {
    message: "Schedule change submitted for admin approval.",
    scheduleRequest: { id: requestId, status: S.PENDING },
  };
}

export interface SubmitWindowCreateInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly weekday: $Enums.Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly maxPatients: number;
  readonly reason?: string | undefined;
}

export async function submitWindowCreateRequest(
  input: SubmitWindowCreateInput,
): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  const window: WindowShape = {
    weekday: input.weekday,
    startTime: input.startTime,
    endTime: input.endTime,
    maxPatients: input.maxPatients,
  };
  await assertNoScheduleOverlap(prisma, input.doctorId, window);
  return submit({
    actor: input.actor,
    doctorId: input.doctorId,
    type: T.WINDOW_CREATE,
    payload: jsonInput(window),
    details: [
      `Weekday: ${input.weekday}`,
      `Time: ${input.startTime} - ${input.endTime}`,
      `Capacity: ${input.maxPatients} patients per slot`,
    ],
    reason: input.reason?.trim() || "Doctor requested a new weekly window",
    ip: input.ip,
    requestId: input.requestId,
  });
}

export interface SubmitWindowUpdateInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly scheduleId: string;
  readonly patch: {
    readonly weekday?: $Enums.Weekday | undefined;
    readonly startTime?: string | undefined;
    readonly endTime?: string | undefined;
    readonly maxPatients?: number | undefined;
  };
  readonly reason: string;
}

export async function submitWindowUpdateRequest(
  input: SubmitWindowUpdateInput,
): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  if (input.patch.maxPatients !== undefined) {
    throw new AppError(403, "FORBIDDEN", "Only an admin or staff member can change a window's capacity");
  }

  const existing = await loadScheduleRow(prisma, input.scheduleId);
  if (existing.doctorId !== input.doctorId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
  const merged: WindowShape = {
    weekday: input.patch.weekday ?? (existing.weekday as $Enums.Weekday),
    startTime: input.patch.startTime ?? hhmm(existing.startTime),
    endTime: input.patch.endTime ?? hhmm(existing.endTime),
  };
  const before: WindowShape = {
    weekday: existing.weekday as $Enums.Weekday,
    startTime: hhmm(existing.startTime),
    endTime: hhmm(existing.endTime),
    maxPatients: existing.maxPatients,
  };
  if (
    merged.weekday === before.weekday &&
    merged.startTime === before.startTime &&
    merged.endTime === before.endTime
  ) {
    throw new AppError(409, "NO_CHANGES", "No fields changed");
  }
  if (merged.endTime <= merged.startTime) {
    throw new AppError(422, "INVALID_WINDOW", "endTime must be after startTime (windows cannot run overnight)");
  }
  await assertNoScheduleOverlap(prisma, input.doctorId, merged, input.scheduleId);

  return submit({
    actor: input.actor,
    doctorId: input.doctorId,
    type: T.WINDOW_UPDATE,
    scheduleId: input.scheduleId,
    payload: jsonInput(merged),
    previousValues: {
      ...before,
      updatedAt: existing.updatedAt.toISOString(),
    } as Prisma.InputJsonObject,
    details: [
      `Weekday: ${before.weekday} -> ${merged.weekday}`,
      `Time: ${before.startTime}-${before.endTime} -> ${merged.startTime}-${merged.endTime}`,
    ],
    reason: input.reason.trim(),
    ip: input.ip,
    requestId: input.requestId,
  });
}

export interface SubmitWindowDeleteInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly scheduleId: string;
  readonly reason: string;
}

export async function submitWindowDeleteRequest(
  input: SubmitWindowDeleteInput,
): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  const existing = await loadScheduleRow(prisma, input.scheduleId);
  if (existing.doctorId !== input.doctorId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
  const before: WindowShape = {
    weekday: existing.weekday as $Enums.Weekday,
    startTime: hhmm(existing.startTime),
    endTime: hhmm(existing.endTime),
    maxPatients: existing.maxPatients,
  };

  return submit({
    actor: input.actor,
    doctorId: input.doctorId,
    type: T.WINDOW_DELETE,
    scheduleId: input.scheduleId,
    payload: { scheduleId: input.scheduleId } as Prisma.InputJsonObject,
    previousValues: {
      ...before,
      updatedAt: existing.updatedAt.toISOString(),
    } as Prisma.InputJsonObject,
    details: [
      `Weekday: ${before.weekday}`,
      `Time: ${before.startTime}-${before.endTime}`,
      "Existing slots and bookings will be left unchanged.",
    ],
    reason: input.reason.trim(),
    ip: input.ip,
    requestId: input.requestId,
  });
}

export interface SubmitUnavailabilityCreateInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly reason: string;
}

export async function submitUnavailabilityCreateRequest(
  input: SubmitUnavailabilityCreateInput,
): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  await loadWritableDoctor(prisma, input.doctorId);
  const clinic = await getClinicSettings();
  const startAt = localDateTimeToUtc({ date: input.date, time: input.startTime }, clinic.timezone);
  const endAt = localDateTimeToUtc({ date: input.date, time: input.endTime }, clinic.timezone);
  assertValidDisruptionWindow(startAt, endAt);

  const overlapping = await prisma.appointment.findMany({
    where: {
      doctorId: input.doctorId,
      slot: { startAt: { lt: endAt }, endAt: { gt: startAt } },
    },
    select: { id: true, status: true },
  });
  const affectedPreview = selectOnlyConfirmed(overlapping).length;

  return submit({
    actor: input.actor,
    doctorId: input.doctorId,
    type: T.UNAVAILABILITY_CREATE,
    payload: {
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    } as Prisma.InputJsonObject,
    details: [
      `Date: ${input.date}`,
      `Time: ${input.startTime} - ${input.endTime}`,
      `Confirmed bookings that would be affected: ${affectedPreview}`,
    ],
    reason: input.reason.trim(),
    affectedPreview,
    ip: input.ip,
    requestId: input.requestId,
  });
}

export interface SubmitUnavailabilityDeleteInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly unavailabilityId: string;
  readonly reason: string;
}

export async function submitUnavailabilityDeleteRequest(
  input: SubmitUnavailabilityDeleteInput,
): Promise<ScheduleChangeSubmissionResult> {
  assertDoctorSelf(input.actor, input.doctorId);
  const existing = await prisma.doctorUnavailability.findUnique({ where: { id: input.unavailabilityId } });
  if (existing === null) {
    throw new AppError(404, "UNAVAILABILITY_NOT_FOUND", "Unavailability not found");
  }
  if (existing.doctorId !== input.doctorId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
  const referencing = await prisma.appointment.count({
    where: { doctorUnavailabilityId: existing.id },
  });
  if (referencing > 0) {
    throw new AppError(
      409,
      "UNAVAILABILITY_IN_USE",
      "This unavailability has affected appointments and cannot be removed",
    );
  }

  return submit({
    actor: input.actor,
    doctorId: input.doctorId,
    type: T.UNAVAILABILITY_DELETE,
    unavailabilityId: existing.id,
    payload: { unavailabilityId: existing.id } as Prisma.InputJsonObject,
    previousValues: {
      startAt: existing.startAt.toISOString(),
      endAt: existing.endAt.toISOString(),
      reason: existing.reason,
    } as Prisma.InputJsonObject,
    details: [
      `Window: ${existing.startAt.toISOString()} - ${existing.endAt.toISOString()}`,
      `Original reason: ${existing.reason}`,
    ],
    reason: input.reason.trim(),
    ip: input.ip,
    requestId: input.requestId,
  });
}

function toDto(row: {
  id: string;
  doctorId: string;
  type: $Enums.DoctorScheduleChangeType;
  status: $Enums.DoctorScheduleChangeStatus;
  payload: Prisma.JsonValue;
  details: Prisma.JsonValue;
  reason: string;
  affectedPreview: number | null;
  requestedByName: string;
  requestedAt: Date;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  doctor: { fullName: string; email: string | null; patientProfile: { phone: string } | null };
}): DoctorScheduleChangeRequestDto {
  return {
    id: row.id,
    doctorId: row.doctorId,
    doctorName: row.doctor.fullName,
    doctorEmail: row.doctor.email,
    doctorPhone: row.doctor.patientProfile?.phone ?? null,
    type: row.type,
    status: row.status,
    details: readStringArray(row.details),
    reason: row.reason,
    affectedPreview: row.affectedPreview,
    requestedByName: row.requestedByName,
    requestedAt: row.requestedAt.toISOString(),
    reviewedByName: row.reviewedByName,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
  };
}

const LIST_INCLUDE = {
  doctor: {
    select: {
      fullName: true,
      email: true,
      patientProfile: { select: { phone: true } },
    },
  },
} as const;

/** The doctor's own submissions, newest first (all decisions, not just pending). */
export async function listMyScheduleChangeRequests(
  actor: ActorContext,
): Promise<{ requests: DoctorScheduleChangeRequestDto[] }> {
  assertDoctorSelf(actor, actor.id);
  const rows = await prisma.doctorScheduleChangeRequest.findMany({
    where: { doctorId: actor.id },
    include: LIST_INCLUDE,
    orderBy: { requestedAt: "desc" },
    take: 100,
  });
  return { requests: rows.map(toDto) };
}

/** The admin queue, newest first, with status and optional doctor filters. */
export async function listDoctorScheduleChangeRequests(input: {
  readonly status?: $Enums.DoctorScheduleChangeStatus | undefined;
  readonly doctorId?: string | undefined;
  readonly limit: number;
}): Promise<{ requests: DoctorScheduleChangeRequestDto[] }> {
  const rows = await prisma.doctorScheduleChangeRequest.findMany({
    where: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.doctorId !== undefined && { doctorId: input.doctorId }),
    },
    include: LIST_INCLUDE,
    orderBy: { requestedAt: "desc" },
    take: input.limit,
  });
  return { requests: rows.map(toDto) };
}

async function loadRequestForReview(requestId: string) {
  const row = await prisma.doctorScheduleChangeRequest.findUnique({
    where: { id: requestId },
    include: {
      doctor: {
        select: {
          fullName: true,
          email: true,
          doctorProfile: { select: { verificationStatus: true } },
        },
      },
    },
  });
  if (row === null) {
    throw new AppError(404, "SCHEDULE_CHANGE_NOT_FOUND", "Schedule change request not found");
  }
  if (row.status !== S.PENDING) {
    throw new AppError(409, "SCHEDULE_CHANGE_REVIEWED", "This request has already been reviewed");
  }
  return row;
}

async function queueDoctorDecision(
  client: DbClient,
  input: {
    readonly requestId: string;
    readonly doctorId: string;
    readonly decision: "APPROVED" | "REJECTED";
  },
): Promise<{ notificationId: string; fullName: string } | null> {
  const doctor = await client.user.findUnique({
    where: { id: input.doctorId },
    select: { fullName: true, email: true },
  });
  if (doctor === null || doctor.email === null || doctor.email.trim().length === 0) return null;
  const notification = await queueNotification(client, {
    type:
      input.decision === "APPROVED"
        ? $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_APPROVED
        : $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_REJECTED,
    recipient: doctor.email,
  });
  return { notificationId: notification.id, fullName: doctor.fullName };
}

async function applyApprovedChange(
  tx: DbClient,
  row: NonNullable<Awaited<ReturnType<typeof loadRequestForReview>>>,
  actor: ActorContext,
  input: ReviewScheduleChangeInput,
): Promise<void> {
  await loadWritableDoctor(tx, row.doctorId);
  const details = readStringArray(row.details);

  switch (row.type) {
    case T.WINDOW_CREATE: {
      const window = readWindow(row.payload);
      if (window === null || window.maxPatients === undefined) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This request has no usable window values");
      }
      await assertNoScheduleOverlap(tx, row.doctorId, window);
      const created = await tx.schedule.create({
        data: {
          doctorId: row.doctorId,
          weekday: window.weekday as $Enums.Weekday,
          startTime: new Date(Date.UTC(1970, 0, 1, Number(window.startTime.slice(0, 2)), Number(window.startTime.slice(3, 5)), 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, Number(window.endTime.slice(0, 2)), Number(window.endTime.slice(3, 5)), 0)),
          maxPatients: window.maxPatients,
        },
      });
      await writeAudit(tx, {
        action: "SCHEDULE_CREATED",
        targetType: "schedule",
        targetId: created.id,
        actor,
        after: jsonValue(window),
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: "SCHEDULE_CREATED",
        actor,
        metadata: { requestId: row.id, ...window },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      return;
    }

    case T.WINDOW_UPDATE: {
      const window = readWindow(row.payload);
      if (window === null || row.scheduleId === null) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This request has no usable window values");
      }
      const existing = await loadScheduleRow(tx, row.scheduleId);
      if (existing.doctorId !== row.doctorId) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This window no longer belongs to the doctor");
      }
      assertSameUpdatedAt(existing, row.previousValues);
      await assertNoScheduleOverlap(tx, row.doctorId, window, row.scheduleId);
      const updated = await tx.schedule.update({
        where: { id: existing.id },
        data: {
          weekday: window.weekday as $Enums.Weekday,
          startTime: new Date(Date.UTC(1970, 0, 1, Number(window.startTime.slice(0, 2)), Number(window.startTime.slice(3, 5)), 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, Number(window.endTime.slice(0, 2)), Number(window.endTime.slice(3, 5)), 0)),
        },
      });
      await writeAudit(tx, {
        action: "SCHEDULE_UPDATED",
        targetType: "schedule",
        targetId: updated.id,
        actor,
        ...(row.previousValues !== null && { before: jsonValue(row.previousValues) }),
        after: jsonValue(window),
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: "SCHEDULE_UPDATED",
        actor,
        metadata: { requestId: row.id, details },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      return;
    }

    case T.WINDOW_DELETE: {
      if (row.scheduleId === null) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This request has no target window");
      }
      const existing = await loadScheduleRow(tx, row.scheduleId);
      if (existing.doctorId !== row.doctorId) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This window no longer belongs to the doctor");
      }
      assertSameUpdatedAt(existing, row.previousValues);
      await tx.schedule.delete({ where: { id: existing.id } });
      await writeAudit(tx, {
        action: "SCHEDULE_DELETED",
        targetType: "schedule",
        targetId: existing.id,
        actor,
        ...(row.previousValues !== null && { before: jsonValue(row.previousValues) }),
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: "SCHEDULE_DELETED",
        actor,
        metadata: { requestId: row.id, details },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      return;
    }

    case T.UNAVAILABILITY_CREATE: {
      const window = readUnavailability(row.payload);
      if (window === null) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This request has no usable time-off window");
      }
      assertValidDisruptionWindow(window.startAt, window.endAt);
      const created = await tx.doctorUnavailability.create({
        data: {
          doctorId: row.doctorId,
          createdById: actor.id,
          startAt: window.startAt,
          endAt: window.endAt,
          reason: row.reason,
        },
      });
      const cascade = await applyUnavailabilityCascade(tx, {
        doctorId: row.doctorId,
        window: { startAt: window.startAt, endAt: window.endAt },
        disruptionId: created.id,
        reason: row.reason,
        actor,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeAudit(tx, {
        action: "DOCTOR_UNAVAILABILITY_CREATED",
        targetType: "doctor_unavailability",
        targetId: created.id,
        actor,
        after: {
          doctorId: row.doctorId,
          startAt: window.startAt.toISOString(),
          endAt: window.endAt.toISOString(),
          reason: row.reason,
          affectedCount: cascade.affectedAppointmentIds.length,
        },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: "UNAVAILABILITY_CREATED",
        actor,
        metadata: { requestId: row.id, affectedCount: cascade.affectedAppointmentIds.length },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      return;
    }

    case T.UNAVAILABILITY_DELETE: {
      if (row.unavailabilityId === null) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This request has no target time-off window");
      }
      const existing = await tx.doctorUnavailability.findUnique({ where: { id: row.unavailabilityId } });
      if (existing === null || existing.doctorId !== row.doctorId) {
        throw new AppError(409, "SCHEDULE_CHANGE_INVALID", "This time-off window no longer exists for the doctor");
      }
      const referencing = await tx.appointment.count({ where: { doctorUnavailabilityId: existing.id } });
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
        actor,
        ...(row.previousValues !== null && { before: jsonValue(row.previousValues) }),
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      await writeDoctorHistory(tx, {
        doctorId: row.doctorId,
        eventType: "UNAVAILABILITY_REMOVED",
        actor,
        metadata: { requestId: row.id },
        reason: input.reviewNote ?? row.reason,
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });
      return;
    }
  }
}

/** Admin approval: claim + apply + decision notice in one transaction. */
export async function approveScheduleChangeRequest(
  input: ReviewScheduleChangeInput,
): Promise<ReviewScheduleChangeResult> {
  assertAdminReviewer(input.actor);
  const row = await loadRequestForReview(input.scheduleRequestId);

  const decision = await prisma.$transaction(async (tx) => {
    const claimed = await tx.doctorScheduleChangeRequest.updateMany({
      where: { id: input.scheduleRequestId, status: S.PENDING },
      data: {
        status: S.APPROVED,
        reviewedById: input.actor.id,
        reviewedByName: input.actor.name,
        reviewedAt: new Date(),
        ...(input.reviewNote !== undefined && { reviewNote: input.reviewNote.trim() }),
      },
    });
    if (claimed.count !== 1) {
      throw new AppError(409, "SCHEDULE_CHANGE_REVIEWED", "This request has already been reviewed");
    }

    await applyApprovedChange(tx, row, input.actor, input);
    const queued = await queueDoctorDecision(tx, {
      requestId: row.id,
      doctorId: row.doctorId,
      decision: "APPROVED",
    });

    await writeAudit(tx, {
      action: "DOCTOR_SCHEDULE_CHANGE_APPROVED",
      targetType: "doctor_schedule_change_request",
      targetId: row.id,
      actor: input.actor,
      after: { type: row.type, details: readStringArray(row.details) },
      reason: input.reviewNote ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
    await writeDoctorHistory(tx, {
      doctorId: row.doctorId,
      eventType: "SCHEDULE_CHANGE_APPROVED",
      actor: input.actor,
      metadata: { requestId: row.id, type: row.type },
      reason: input.reviewNote ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
    return queued;
  });

  if (decision !== null) {
    dispatchNotificationInBackground(
      decision.notificationId,
      doctorScheduleChangeDecidedEmail({
        fullName: decision.fullName,
        doctorName: row.doctor.fullName,
        action: ACTION_LABELS[row.type],
        details: readStringArray(row.details),
        decision: "APPROVED",
        reviewNote: input.reviewNote?.trim() ?? null,
        link: `${config.CLIENT_URL.replace(/\/$/, "")}/doctor/schedule`,
      }),
    );
  }

  if (row.type === T.WINDOW_CREATE || row.type === T.WINDOW_UPDATE || row.type === T.WINDOW_DELETE) {
    try {
      await materializeSlots({ doctorId: row.doctorId });
    } catch (error) {
      // The template change is committed; a failed top-up is repairable with
      // POST /schedules/materialize and must not turn approval into a false 500.
      logger.error({ err: error, doctorId: row.doctorId }, "post-approval slot materialisation failed");
    }
  }

  return { message: "Schedule change approved and applied.", status: S.APPROVED };
}

/** Admin rejection: claim + decision notice, with no live schedule writes. */
export async function rejectScheduleChangeRequest(
  input: ReviewScheduleChangeInput,
): Promise<ReviewScheduleChangeResult> {
  assertAdminReviewer(input.actor);
  const reason = input.reviewNote?.trim() ?? "";
  if (reason.length === 0) throw new AppError(422, "REASON_REQUIRED", "A reason is required");

  const row = await loadRequestForReview(input.scheduleRequestId);
  const decision = await prisma.$transaction(async (tx) => {
    const claimed = await tx.doctorScheduleChangeRequest.updateMany({
      where: { id: input.scheduleRequestId, status: S.PENDING },
      data: {
        status: S.REJECTED,
        reviewedById: input.actor.id,
        reviewedByName: input.actor.name,
        reviewedAt: new Date(),
        reviewNote: reason,
      },
    });
    if (claimed.count !== 1) {
      throw new AppError(409, "SCHEDULE_CHANGE_REVIEWED", "This request has already been reviewed");
    }

    const queued = await queueDoctorDecision(tx, {
      requestId: row.id,
      doctorId: row.doctorId,
      decision: "REJECTED",
    });
    await writeAudit(tx, {
      action: "DOCTOR_SCHEDULE_CHANGE_REJECTED",
      targetType: "doctor_schedule_change_request",
      targetId: row.id,
      actor: input.actor,
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
    await writeDoctorHistory(tx, {
      doctorId: row.doctorId,
      eventType: "SCHEDULE_CHANGE_REJECTED",
      actor: input.actor,
      metadata: { requestId: row.id, type: row.type },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
    return queued;
  });

  if (decision !== null) {
    dispatchNotificationInBackground(
      decision.notificationId,
      doctorScheduleChangeDecidedEmail({
        fullName: decision.fullName,
        doctorName: row.doctor.fullName,
        action: ACTION_LABELS[row.type],
        details: readStringArray(row.details),
        decision: "REJECTED",
        reviewNote: reason,
        link: `${config.CLIENT_URL.replace(/\/$/, "")}/doctor/schedule`,
      }),
    );
  }

  return { message: "Schedule change rejected.", status: S.REJECTED };
}
