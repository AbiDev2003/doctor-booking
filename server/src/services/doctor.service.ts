import { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import type { DbClient } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { generateToken, hashToken, getAccountClaimExpiry } from "../lib/auth.js";
import { assertDoctorAction, isBookable } from "../lib/doctorState.js";
import type { DoctorAction } from "../lib/doctorState.js";
import { clinicDayRange, utcToLocalDateTime } from "../lib/time.js";
import { maskContact } from "../lib/privacy.js";
import { writeAudit } from "./audit.service.js";
import { revokeAllSessions } from "./auth.service.js";

/**
 * plan.md §5, §5.1, §5.2 — the doctor lifecycle, Day 12.
 *
 * Shape of everything in this file, without exception:
 *
 *   read the target → `assertDoctorAction` (pure §5 matrix, lib/doctorState.ts)
 *   → ONE transaction { conditional update (the race guard) + revokeAllSessions
 *      where the plan demands it + writeAudit + writeDoctorHistory }.
 *
 * The conditional `updateMany` inside the transaction is what makes a
 * concurrent actor lose cleanly: two admins suspending at once both pass the
 * matrix, exactly one flips `suspended_at IS NULL`, and the loser gets a 409
 * rather than a second audit row overwriting the first suspension's timestamp
 * and reason.
 *
 * **§12 cascade seam (suspend/archive):** plan §5.2 makes suspension and
 * archive auto-trigger the §12 affected-appointment cascade (email every
 * patient with a future CONFIRMED booking, waive the cutoff, auto-cancel and
 * refund at slot end). Appointments do not exist until Day 19 and refunds
 * until Day 24, so the loop lands with Day 18's unavailability cascade — the
 * same code, because §12 says suspension "reuses this same cascade". Each
 * suspend/archive below carries a marker comment at exactly where it hooks
 * in. What is real TODAY is the other half of immediacy: status flip + every
 * session revoked in the same transaction, so login dies at once (Day 9's
 * per-request re-check in middleware/auth.ts blocks any access token still in
 * flight).
 *
 * **Role limits are enforced twice on purpose:** the route gates (Day 10's
 * `requireRole`) decide who may reach each endpoint, and the matrix re-decides
 * inside the service. TypeScript cannot see middleware composition, and a
 * route wired in the wrong order is exactly the kind of mistake that survives
 * until an attacker finds it. The matrix is also where the role rules are
 * unit-tested (tests/doctorState.test.ts), so they must live there regardless.
 */

/** The actor behind a §20/§5.2 write: identity + the name snapshot (§20). */
export interface ActorContext {
  readonly id: string;
  readonly role: $Enums.UserRole;
  readonly name: string;
}

/** What every route here contributes to its audit/history rows. */
export interface RequestMeta {
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * §5.2's verification-impacting set — a change to ANY of these forces
 * re-verification. Locked by plan §5.2 (qualification, medical license,
 * specialization, experience, clinic/hospital association) and deliberately
 * NOT containing `consultationFee`: money is clinic configuration, not a
 * credential, so a fee change never costs the doctor their badge. It is
 * separately restricted to ADMIN/STAFF (a doctor may not set their own price).
 */
const CREDENTIAL_FIELDS = [
  "qualification",
  "licenseNumber",
  "experience",
  "clinicAssociation",
  "specialization",
] as const;

type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

/** §5's "required verification information" — checked before an ADMIN verifies. */
const REQUIRED_VERIFICATION_FIELDS: readonly CredentialField[] = [
  "qualification",
  "licenseNumber",
  "specialization",
  "experience",
  "clinicAssociation",
];

const S = $Enums.DoctorVerificationStatus;

/* ------------------------------------------------------------------ */
/* DoctorHistory — the append-only per-doctor timeline (§5, §20)       */
/* ------------------------------------------------------------------ */

export interface DoctorHistoryEntry {
  readonly doctorId: string;
  /** Free SCREAMING_SNAKE-adjacent text, not an enum — see schema.prisma. */
  readonly eventType: string;
  readonly actor: { readonly id?: string | null; readonly role?: $Enums.UserRole | null; readonly name: string };
  readonly metadata?: Prisma.InputJsonValue | undefined;
  readonly reason?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * The `writeAudit` twin for `DoctorHistory` — same contract: takes the
 * transaction client so the event commits with the change it describes, insert
 * only (append-only, §20), throws rather than swallowing (a missing timeline
 * row is exactly the loss an append-only record exists to prevent).
 */
export async function writeDoctorHistory(client: DbClient, entry: DoctorHistoryEntry): Promise<void> {
  await client.doctorHistory.create({
    data: {
      doctorId: entry.doctorId,
      eventType: entry.eventType,
      actorId: entry.actor.id ?? null,
      actorRole: entry.actor.role ?? null,
      actorName: entry.actor.name,
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,
      ...(entry.metadata !== undefined && { metadata: entry.metadata }),
    },
  });
}

/* ------------------------------------------------------------------ */
/* §5.1 — provisioning (invite doctor / invite staff)                  */
/* ------------------------------------------------------------------ */

export interface InviteInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly email: string;
  readonly fullName: string;
}

export interface InviteResult {
  readonly userId: string;
  readonly rawToken: string;
}

/**
 * §5.1 — ADMIN or STAFF creates/invites a doctor. The account is born in the
 * exact state the plan describes: `passwordHash = null` (exists, never
 * claimed — §5.1 forbids temporary passwords), `emailVerifiedAt = null`
 * (set when the claim link is opened), `DoctorProfile.verificationStatus =
 * INVITED` ("has not submitted profile details yet", §5).
 *
 * The invitation token (`ACCOUNT_CLAIM`, 24h) is issued in the same
 * transaction as the account — an invite email whose link was never minted is
 * a broken onboarding that no one notices until the doctor is confused.
 *
 * §6.4: an invitation to an address that is already registered cannot be
 * claimed, so the address is refused up front with the same 409 registration
 * uses. The unique index inside the transaction closes the race between two
 * invites to the same address.
 */
export async function inviteDoctor(input: InviteInput): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "An account with this email address already exists");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          role: $Enums.UserRole.DOCTOR,
          fullName: input.fullName.trim(),
          email,
          passwordHash: null,
          emailVerifiedAt: null,
        },
      });

      await tx.doctorProfile.create({
        data: { userId: user.id, verificationStatus: S.INVITED },
      });

      const rawToken = generateToken(32);
      await tx.authToken.create({
        data: {
          userId: user.id,
          purpose: $Enums.AuthTokenPurpose.ACCOUNT_CLAIM,
          tokenHash: hashToken(rawToken),
          expiresAt: getAccountClaimExpiry(),
          consumedAt: null,
          ip: input.ip ?? null,
        },
      });

      await writeAudit(tx, {
        action: "DOCTOR_INVITED",
        targetType: "doctor",
        targetId: user.id,
        actor: input.actor,
        after: { email, fullName: user.fullName, verificationStatus: S.INVITED },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      await writeDoctorHistory(tx, {
        doctorId: user.id,
        eventType: "INVITED",
        actor: input.actor,
        metadata: { email },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return { userId: user.id, rawToken };
    });
  } catch (err) {
    // Two invites to one address racing past the pre-check: the unique index
    // answers, and it must answer in the plan's vocabulary, not Prisma's.
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "An account with this email address already exists");
    }
    throw err;
  }
}

/**
 * §5.1 — ADMIN invites STAFF. Identical provisioning minus the profile and
 * the doctor timeline: STAFF has no profile table by design (§24), and the
 * `STAFF_INVITED` audit row is the whole record of who was added.
 *
 * Never STAFF-invites-STAFF: §5.1/§4 — STAFF cannot create other staff
 * members. That limit lives on the route (`requireRole(ADMIN)`); this service
 * trusts it the same way inviteDoctor trusts its own route gate, because the
 * matrix does not model User creation (there is no "state" to violate — the
 * row does not exist yet).
 */
export async function inviteStaff(input: InviteInput): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "An account with this email address already exists");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          role: $Enums.UserRole.STAFF,
          fullName: input.fullName.trim(),
          email,
          passwordHash: null,
          emailVerifiedAt: null,
        },
      });

      const rawToken = generateToken(32);
      await tx.authToken.create({
        data: {
          userId: user.id,
          purpose: $Enums.AuthTokenPurpose.ACCOUNT_CLAIM,
          tokenHash: hashToken(rawToken),
          expiresAt: getAccountClaimExpiry(),
          consumedAt: null,
          ip: input.ip ?? null,
        },
      });

      await writeAudit(tx, {
        action: "STAFF_INVITED",
        targetType: "user",
        targetId: user.id,
        actor: input.actor,
        after: { email, fullName: user.fullName, role: $Enums.UserRole.STAFF },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return { userId: user.id, rawToken };
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "An account with this email address already exists");
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

interface DoctorRow {
  readonly id: string;
  readonly role: $Enums.UserRole;
  readonly fullName: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly doctorProfile: {
    readonly verificationStatus: $Enums.DoctorVerificationStatus;
    readonly suspendedAt: Date | null;
    readonly suspendReason: string | null;
    readonly qualification: string | null;
    readonly licenseNumber: string | null;
    readonly experience: string | null;
    readonly clinicAssociation: string | null;
    readonly specialization: string | null;
    readonly consultationFee: number | null;
  } | null;
}

/**
 * One DTO shape for list and detail, so Day 13's public surface can thin it
 * and the admin/staff screens show the suspended/bookable state without
 * recomputing §5's rule themselves: `isBookable` is derived, never stored.
 * The roster deliberately includes ARCHIVED doctors — an admin must be able
 * to find the doctor they are about to un-archive (§5.2).
 */
function toDoctorDto(row: DoctorRow) {
  const profile = row.doctorProfile;
  if (!profile) {
    // A role=DOCTOR user without a profile is unreachable through every write
    // path (inviteDoctor creates both in one transaction) — a data answer,
    // routed to the caller as "not a doctor" rather than a 500.
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    verificationStatus: profile.verificationStatus,
    suspendedAt: profile.suspendedAt,
    suspendReason: profile.suspendReason,
    qualification: profile.qualification,
    licenseNumber: profile.licenseNumber,
    experience: profile.experience,
    clinicAssociation: profile.clinicAssociation,
    specialization: profile.specialization,
    consultationFee: profile.consultationFee,
    isBookable: isBookable(profile),
    createdAt: row.createdAt,
  };
}

const doctorSelect = {
  id: true,
  role: true,
  fullName: true,
  email: true,
  createdAt: true,
  doctorProfile: true,
} as const;

/** ADMIN/STAFF roster — see `toDoctorDto` on why ARCHIVED rows are included. */
export async function listDoctors(): Promise<ReturnType<typeof toDoctorDto>[]> {
  const users = await prisma.user.findMany({
    where: { role: $Enums.UserRole.DOCTOR },
    select: doctorSelect,
    orderBy: { createdAt: "desc" },
  });
  return users.map(toDoctorDto);
}

/**
 * Detail view. Reachable by ADMIN/STAFF on anyone and by the DOCTOR on
 * themself — the self-or-role split is decided in the route (Day 10's
 * `requireSelfOrRole`), not here: by the time a service call happens, the
 * authorization question has already been answered.
 */
export async function getDoctor(doctorId: string): Promise<ReturnType<typeof toDoctorDto>> {
  const user = await prisma.user.findUnique({
    where: { id: doctorId },
    select: doctorSelect,
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  return toDoctorDto(user);
}

/* ------------------------------------------------------------------ */
/* §28 — today's queue (Day 14, read-only)                             */
/* ------------------------------------------------------------------ */

/**
 * The queue the doctor's Overview and Queue screens render. Two §28 rules
 * fully decide its shape:
 *
 * **"Today" is the clinic's day, not the server's.** `clinicDayRange` turns
 * "now" into the UTC instants bounding the clinic's calendar day (the same
 * zone the seed used to build `startAt`/`endAt` — `config.APP_TIMEZONE`), so a
 * server in UTC never splits or merges a clinic session. A slot is today's if
 * its `startAt` falls inside that window.
 *
 * **The contact is masked server-side, or not sent at all.** The patient's
 * E.164 full number never leaves the API in this response (`maskContact` in
 * `lib/privacy.ts` keeps the last four digits) — §7 does not trust a doctor's
 * device with the full value, yet a desk user needs enough to tell two
 * same-named patients apart. Only the phone is exposed: appointments carry no
 * email by design, so there is nothing else to leak.
 */

export interface TodayQueueEntry {
  readonly appointmentId: string;
  readonly patientName: string;
  /** Last-four-digit mask; the full E.164 value never appears here. */
  readonly maskedContact: string;
  readonly status: $Enums.AppointmentStatus;
  readonly bookingTime: Date;
  /** "Up next": the first CONFIRMED/ARRIVED booking among windows still open. */
  readonly upNext: boolean;
}

export interface TodaySlotQueue {
  readonly slotId: string;
  /** Clinic-local calendar date (`@db.Date` read back through the zone). */
  readonly slotDate: string;
  /** Clinic-local wall clock, e.g. "09:00:00", straight from the stored columns. */
  readonly startTime: string;
  readonly endTime: string;
  readonly queue: readonly TodayQueueEntry[];
}

export interface TodayQueue {
  readonly date: string;
  readonly slots: readonly TodaySlotQueue[];
}

/**
 * `status` controls whether a booking is *in* the day-queue at all. CANCELLED
 * and REJECTED leave no trace in the waiting room; the queue lists who is
 * coming, waiting, attended, or was marked absent (§28 includes NO_SHOW and
 * COMPLETED as flags).
 */
const QUEUE_STATUSES = [
  $Enums.AppointmentStatus.CONFIRMED,
  $Enums.AppointmentStatus.ARRIVED,
  $Enums.AppointmentStatus.COMPLETED,
  $Enums.AppointmentStatus.NO_SHOW,
] as const;

export async function getTodayQueue(
  doctorId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<TodayQueue> {
  const range = clinicDayRange(now, timeZone);

  const rows = await prisma.appointment.findMany({
    where: {
      doctorId,
      slot: { startAt: { gte: range.start, lt: range.endExclusive } },
      status: { in: [...QUEUE_STATUSES] },
    },
    select: {
      id: true,
      status: true,
      bookingTime: true,
      slot: {
        select: {
          id: true,
          slotDate: true,
          startTime: true,
          endTime: true,
          startAt: true,
          endAt: true,
        },
      },
      patient: { select: { fullName: true, patientProfile: { select: { phone: true } } } },
    },
    orderBy: [{ slot: { startAt: "asc" } }, { bookingTime: "asc" }],
  });

  // Group by slot, preserving the window then booking-time order the query
  // returned (rows all share a single day, so window order needs remembered).
  const bySlot = new Map<string, TodaySlotQueue>();
  const slotEndsAt = new Map<string, Date>();
  for (const row of rows) {
    let slot = bySlot.get(row.slot.id);
    if (!slot) {
      const created: TodaySlotQueue = {
        slotId: row.slot.id,
        // `slotDate`/`startTime`/`endTime` are timezone-less calendar columns
        // (`@db.Date`/`@db.Time`): Prisma reads them UTC-anchored, so the
        // wall-clock value is the ISO projection, not a clinic-zone
        // conversion (a −05:00 clinic would otherwise read its own stored date
        // as yesterday).
        slotDate: row.slot.slotDate.toISOString().slice(0, 10),
        startTime: row.slot.startTime.toISOString().slice(11, 19),
        endTime: row.slot.endTime.toISOString().slice(11, 19),
        queue: [],
      };
      bySlot.set(row.slot.id, created);
      slotEndsAt.set(row.slot.id, row.slot.endAt);
      slot = created;
    }
    (slot.queue as TodayQueueEntry[]).push({
      appointmentId: row.id,
      patientName: row.patient.fullName,
      maskedContact: maskContact(row.patient.patientProfile?.phone ?? ""),
      status: row.status,
      bookingTime: row.bookingTime,
      upNext: false,
    });
  }

  // §28's "up next" is the first booking still in the room, not merely the
  // first row: a COMPLETED early slot must not keep the flag, and a group
  // whose window has ended is over regardless of who is listed. Walk in
  // window-then-booking order and flag the first CONFIRMED/ARRIVED whose slot
  // has not ended; leave the rest unflagged.
  let flagged = false;
  for (const slot of bySlot.values()) {
    const windowOpen = slotEndsAt.get(slot.slotId)! > now;
    for (const entry of slot.queue as TodayQueueEntry[]) {
      const waiting = entry.status === $Enums.AppointmentStatus.CONFIRMED || entry.status === $Enums.AppointmentStatus.ARRIVED;
      if (!flagged && windowOpen && waiting) {
        (entry as { upNext: boolean }).upNext = true;
        flagged = true;
      }
    }
  }

  return {
    date: utcToLocalDateTime(range.start, timeZone).date,
    slots: [...bySlot.values()],
  };
}

/* ------------------------------------------------------------------ */
/* §5.2 — profile edits (descriptive vs credential)                    */
/* ------------------------------------------------------------------ */

export interface UpdateDoctorProfilePatch {
  readonly fullName?: string | undefined;
  readonly qualification?: string | undefined;
  readonly licenseNumber?: string | undefined;
  readonly experience?: string | undefined;
  readonly clinicAssociation?: string | undefined;
  readonly specialization?: string | undefined;
  readonly consultationFee?: number | undefined;
}

export interface UpdateDoctorProfileInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly patch: UpdateDoctorProfilePatch;
}

export interface UpdateDoctorProfileResult {
  /** PENDING_VERIFICATION when a credential moved; unchanged otherwise (§5.2). */
  readonly verificationStatus: $Enums.DoctorVerificationStatus;
}

interface LoadedDoctor {
  readonly user: { readonly id: string; readonly fullName: string };
  readonly profile: NonNullable<DoctorRow["doctorProfile"]>;
}

/** The read half of every state action: 404 on anything that is not a doctor. */
async function loadDoctorRow(client: DbClient, doctorId: string): Promise<LoadedDoctor> {
  const user = await client.user.findUnique({
    where: { id: doctorId },
    select: { id: true, role: true, fullName: true, doctorProfile: true },
  });
  if (!user || user.role !== $Enums.UserRole.DOCTOR || !user.doctorProfile) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  return { user: { id: user.id, fullName: user.fullName }, profile: user.doctorProfile };
}

/**
 * §5.2's field split, enforced on every edit:
 *
 * - **Credential change** (any of `CREDENTIAL_FIELDS`) → status is forced to
 *   `PENDING_VERIFICATION`, by ANY actor — self, STAFF or ADMIN — and
 *   `suspendedAt` is deliberately NOT touched (§5.2: editing a suspended
 *   doctor's credentials must not silently un-suspend them). Existing
 *   appointments are untouched by construction: this function moves a status,
 *   never a booking (the hide-from-new-bookings half is Phase 4's listing
 *   filter, applied through `isBookable`).
 * - **Descriptive change only** (name, fee) → status does not move.
 * - **Either kind on an ARCHIVED or REJECTED doctor** → refused by the matrix
 *   before any write: ARCHIVED restores only through UNARCHIVE, REJECTED is
 *   terminal (§5).
 *
 * The `updateMany` re-check inside the transaction closes the window between
 * the matrix read and the write: an archive committed in that window makes
 * the count 0, and because the user-name update is in the same transaction,
 * no half-edit can land on a doctor the plan says is untouchable.
 *
 * `consultationFee` is ADMIN/STAFF-only (checked at the top): money is clinic
 * configuration, and a doctor may not set their own price — §5.2's "STAFF may
 * edit descriptive fields" is the clinic acting on a doctor's listing, not
 * the doctor acting on their contract.
 */
export async function updateDoctorProfile(
  input: UpdateDoctorProfileInput,
): Promise<UpdateDoctorProfileResult> {
  const target = await prisma.user.findUnique({
    where: { id: input.doctorId },
    select: { role: true, fullName: true, doctorProfile: true },
  });
  if (!target || target.role !== $Enums.UserRole.DOCTOR || !target.doctorProfile) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  const profile = target.doctorProfile;

  if (input.patch.consultationFee !== undefined && input.actor.role === $Enums.UserRole.DOCTOR) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }

  // Prisma's InputJsonObject index is readonly; this mutable twin assigns the
  // same values and is assignable to it (and to writeAudit's InputJsonValue).
  const before: Record<string, Prisma.InputJsonValue | null> = {};
  const after: Record<string, Prisma.InputJsonValue | null> = {};
  const changedCredentials: Partial<Record<CredentialField, string>> = {};
  let credentialChanged = false;
  let nameChanged = false;

  for (const field of CREDENTIAL_FIELDS) {
    const value = input.patch[field];
    if (value === undefined || value.trim() === (profile[field] ?? "").trim()) continue;
    before[field] = profile[field];
    after[field] = value;
    changedCredentials[field] = value;
    credentialChanged = true;
  }

  if (input.patch.fullName !== undefined && input.patch.fullName.trim() !== target.fullName.trim()) {
    before.fullName = target.fullName;
    after.fullName = input.patch.fullName;
    nameChanged = true;
  }

  const feeChanged =
    input.patch.consultationFee !== undefined && input.patch.consultationFee !== profile.consultationFee;
  if (feeChanged) {
    before.consultationFee = profile.consultationFee;
    after.consultationFee = input.patch.consultationFee;
  }

  if (!credentialChanged && !nameChanged && !feeChanged) {
    throw new AppError(409, "NO_CHANGES", "No fields changed");
  }

  const action: DoctorAction = credentialChanged ? "EDIT_CREDENTIALS" : "EDIT_PROFILE";
  assertDoctorAction(profile, action, input.actor);

  const nextStatus = credentialChanged ? S.PENDING_VERIFICATION : profile.verificationStatus;
  if (credentialChanged) {
    after.verificationStatus = S.PENDING_VERIFICATION;
  }

  await prisma.$transaction(async (tx) => {
    const profileData: Prisma.DoctorProfileUpdateManyMutationInput = { ...changedCredentials };
    if (credentialChanged) {
      profileData.verificationStatus = S.PENDING_VERIFICATION;
      // suspendedAt absent BY RULE — see the doc comment. This is the line §5.2
      // exists to keep: nothing else in this function may add it to `data`.
    }

    const updated = await tx.doctorProfile.updateMany({
      where: {
        userId: input.doctorId,
        verificationStatus: { notIn: [S.ARCHIVED, S.REJECTED] },
      },
      data: profileData,
    });
    if (updated.count !== 1) {
      const current = await tx.doctorProfile.findUnique({
        where: { userId: input.doctorId },
        select: { verificationStatus: true },
      });
      if (current?.verificationStatus === S.ARCHIVED) {
        throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived. Un-archive it first.");
      }
      if (current?.verificationStatus === S.REJECTED) {
        throw new AppError(409, "DOCTOR_REJECTED", "This doctor was rejected. A new invitation is required.");
      }
      throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
    }

    if (nameChanged && input.patch.fullName !== undefined) {
      await tx.user.update({
        where: { id: input.doctorId },
        data: { fullName: input.patch.fullName.trim() },
      });
    }

    const eventType = credentialChanged ? "CREDENTIALS_UPDATED" : "PROFILE_UPDATED";
    const auditAction = credentialChanged ? "DOCTOR_CREDENTIALS_UPDATED" : "DOCTOR_PROFILE_UPDATED";

    await writeAudit(tx, {
      action: auditAction,
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before,
      after,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType,
      actor: input.actor,
      metadata: { before, after },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });

  return { verificationStatus: nextStatus };
}

/* ------------------------------------------------------------------ */
/* §5 — verification decisions (ADMIN-only)                            */
/* ------------------------------------------------------------------ */

export interface DoctorStateActionInput extends RequestMeta {
  readonly actor: ActorContext;
  readonly doctorId: string;
  readonly reason?: string | undefined;
}

/**
 * `PENDING_VERIFICATION → VERIFIED`, ADMIN-only — and the last checkpoint for
 * §5's "Required verification information": the matrix has already proven the
 * actor may decide and the doctor is pending; this refuses to badge a doctor
 * whose qualification/license/specialization/experience/association is
 * incomplete. The rule could have lived at submission time, but a credential
 * edit triggers re-verification automatically (§5.2) with no submit step to
 * intercept — so the only moment that sees EVERY path is the decision itself.
 *
 * Suspension is orthogonal: verifying a suspended doctor is allowed and leaves
 * `suspendedAt` set, so they become verifiable-but-unbookable — un-suspending
 * later restores bookability without a second verification (§5's derived
 * rules).
 */
export async function verifyDoctor(input: DoctorStateActionInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "VERIFY", input.actor);

    const missing = REQUIRED_VERIFICATION_FIELDS.filter((field) => !(profile[field] ?? "").trim());
    if (missing.length > 0) {
      throw new AppError(
        422,
        "VERIFICATION_INCOMPLETE",
        "Required verification information is missing",
        { missing },
      );
    }

    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, verificationStatus: S.PENDING_VERIFICATION },
      data: { verificationStatus: S.VERIFIED },
    });
    if (updated.count !== 1) {
      throw new AppError(
        409,
        "INVALID_STATE_TRANSITION",
        "VERIFY is not allowed — the doctor's status changed; reload and retry",
      );
    }

    await writeAudit(tx, {
      action: "DOCTOR_VERIFIED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { verificationStatus: S.PENDING_VERIFICATION },
      after: { verificationStatus: S.VERIFIED },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "VERIFIED",
      actor: input.actor,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/**
 * `PENDING_VERIFICATION → REJECTED`, ADMIN-only, mandatory reason (§5: the
 * admin refuses the credentials). Terminal for every normal transition — the
 * matrix refuses edits on a REJECTED doctor, so the only way back is a new
 * invitation (§5).
 */
export async function rejectDoctor(input: DoctorStateActionInput): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new AppError(422, "REASON_REQUIRED", "A reason is required");
  }

  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "REJECT", input.actor);

    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, verificationStatus: S.PENDING_VERIFICATION },
      data: { verificationStatus: S.REJECTED },
    });
    if (updated.count !== 1) {
      throw new AppError(
        409,
        "INVALID_STATE_TRANSITION",
        "REJECT is not allowed — the doctor's status changed; reload and retry",
      );
    }

    await writeAudit(tx, {
      action: "DOCTOR_REJECTED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { verificationStatus: S.PENDING_VERIFICATION },
      after: { verificationStatus: S.REJECTED },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "REJECTED",
      actor: input.actor,
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/* ------------------------------------------------------------------ */
/* §5.2 — suspend / unsuspend / archive / unarchive                    */
/* ------------------------------------------------------------------ */

/**
 * SUSPEND — STAFF or ADMIN, mandatory reason, ONE transaction (§5.2):
 * status columns + every session revoked + audit + history. The revocation is
 * what makes Day 9's DoD real for doctors: refresh tokens die here, and any
 * access token still in flight is refused by the per-request re-check on its
 * next request — not at expiry.
 *
 * §12 CASCADE SEAM (Day 18): every future CONFIRMED appointment for this
 * doctor gets the unavailability cascade — automatic patient emails, cutoff
 * waived, auto-cancel + full refund at slot end. Appointments do not exist
 * until Day 19; the loop lands with Day 18's cascade, which §12 says is the
 * SAME code. Slot re-closing (§8.4) is the other half of that seam.
 */
export async function suspendDoctor(input: DoctorStateActionInput & { readonly reason: string }): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(422, "REASON_REQUIRED", "A reason is required");
  }

  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "SUSPEND", input.actor);

    const now = new Date();
    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, suspendedAt: null },
      data: { suspendedAt: now, suspendReason: reason },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "ALREADY_SUSPENDED", "This doctor is already suspended.");
    }

    await revokeAllSessions(tx, input.doctorId);

    await writeAudit(tx, {
      action: "DOCTOR_SUSPENDED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { suspendedAt: null },
      after: { suspendedAt: now.toISOString(), suspendReason: reason },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "SUSPENDED",
      actor: input.actor,
      reason,
      metadata: { suspendReason: reason },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/**
 * UNSUSPEND — ADMIN-only. Clears `suspendedAt`/`suspendReason` and NOTHING
 * else: whatever `verificationStatus` the doctor held when suspended is the
 * one they return to (§5's whole reason for orthogonal columns). No session
 * is issued or revoked — there is none to touch (the suspension revoked them
 * all, and the doctor logs in fresh).
 *
 * §8.4 SEAM (Day 16/18): slots closed by the suspension are re-enabled only
 * where no overlapping unavailability remains — same deferred slot logic the
 * cascade above waits on.
 */
export async function unsuspendDoctor(input: DoctorStateActionInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "UNSUSPEND", input.actor);

    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, suspendedAt: { not: null } },
      data: { suspendedAt: null, suspendReason: null },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "NOT_SUSPENDED", "This doctor is not suspended.");
    }

    await writeAudit(tx, {
      action: "DOCTOR_UNSUSPENDED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { suspendedAt: profile.suspendedAt?.toISOString() ?? null, suspendReason: profile.suspendReason },
      after: { suspendedAt: null, suspendReason: null },
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "REACTIVATED",
      actor: input.actor,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/**
 * ARCHIVE — STAFF or ADMIN, mandatory reason, terminal soft-delete (§5.2):
 * the same transaction as suspend (sessions revoked, cascade seam) but the
 * lifecycle lands on `ARCHIVED` and the suspension columns are cleared — an
 * archived doctor is not "suspended", they are gone; keeping both set would
 * make un-archive's "clears suspendedAt" a no-op on a value that should never
 * have survived. No row is ever hard-deleted (§5.2, referential integrity).
 */
export async function archiveDoctor(input: DoctorStateActionInput & { readonly reason: string }): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(422, "REASON_REQUIRED", "A reason is required");
  }

  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "ARCHIVE", input.actor);

    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, verificationStatus: { not: S.ARCHIVED } },
      data: { verificationStatus: S.ARCHIVED, suspendedAt: null, suspendReason: null },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is already archived.");
    }

    await revokeAllSessions(tx, input.doctorId);

    // §12 CASCADE SEAM (Day 18) — identical to suspendDoctor's above.

    await writeAudit(tx, {
      action: "DOCTOR_ARCHIVED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { verificationStatus: profile.verificationStatus, suspendedAt: profile.suspendedAt?.toISOString() ?? null },
      after: { verificationStatus: S.ARCHIVED, suspendedAt: null },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "ARCHIVED",
      actor: input.actor,
      reason,
      metadata: { from: profile.verificationStatus },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

/**
 * UNARCHIVE — ADMIN-only, mandatory reason, and it lands on `VERIFIED` by
 * design (§5's locked rule): whoever restores an archived doctor is the
 * authority accepting responsibility for their credentials — the un-archiving
 * admin IS performing §5's verification step at restore time, which is why
 * the matrix skips PENDING_VERIFICATION here. `suspendedAt` is cleared with
 * the archive's columns; a doctor archived while suspended comes back fully
 * bookable, and the audit row says who decided that and why.
 */
export async function unarchiveDoctor(input: DoctorStateActionInput & { readonly reason: string }): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(422, "REASON_REQUIRED", "A reason is required");
  }

  await prisma.$transaction(async (tx) => {
    const { profile } = await loadDoctorRow(tx, input.doctorId);
    assertDoctorAction(profile, "UNARCHIVE", input.actor);

    const updated = await tx.doctorProfile.updateMany({
      where: { userId: input.doctorId, verificationStatus: S.ARCHIVED },
      data: { verificationStatus: S.VERIFIED, suspendedAt: null, suspendReason: null },
    });
    if (updated.count !== 1) {
      throw new AppError(409, "NOT_ARCHIVED", "This doctor is not archived.");
    }

    await writeAudit(tx, {
      action: "DOCTOR_UNARCHIVED",
      targetType: "doctor",
      targetId: input.doctorId,
      actor: input.actor,
      before: { verificationStatus: S.ARCHIVED },
      after: { verificationStatus: S.VERIFIED, suspendedAt: null },
      reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    await writeDoctorHistory(tx, {
      doctorId: input.doctorId,
      eventType: "UNARCHIVED",
      actor: input.actor,
      reason,
      metadata: { to: S.VERIFIED },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });
  });
}
