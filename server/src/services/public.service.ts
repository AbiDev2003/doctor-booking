import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";

/**
 * plan.md §26 — the public doctor surface, Day 13.
 *
 * Three rules shape everything here:
 *
 * - **Bookable is the §5 filter, applied as a WHERE.** The public list shows
 *   exactly the doctors `isBookable` would vouch for (VERIFIED and not
 *   suspended) — written as a query against the two columns, with the pure
 *   rule kept in `lib/doctorState.ts` as the single definition. Listing and
 *   booking can never disagree because there is only one rule, applied at both
 *   ends.
 * - **The DTO is an allow-list, not the admin DTO thinned.** `toDoctorDto` in
 *   doctor.service.ts is for the roster; a future field added to it must not
 *   silently become public. This mapper names every field it emits, so a new
 *   column needs an explicit decision to appear here. `licenseNumber` and
 *   `email` are deliberately absent: they are PII an unauthenticated caller
 *   has no business with (§26 lists what a profile shows; credentials are not
 *   on it).
 * - **The fee is resolved once, on the server.** `consultationFee ??`
 *   `clinic.defaultConsultationFee` is §3.2's fallback, applied here so the
 *   card a patient sees matches the price the desk charges.
 */

interface PublicDoctorRow {
  id: string;
  fullName: string;
  doctorProfile: {
    verificationStatus: $Enums.DoctorVerificationStatus;
    suspendedAt: Date | null;
    qualification: string | null;
    licenseNumber: string | null;
    experience: string | null;
    clinicAssociation: string | null;
    specialization: string | null;
    consultationFee: number | null;
  } | null;
}

export interface PublicDoctor {
  readonly id: string;
  readonly fullName: string;
  readonly qualification: string | null;
  readonly experience: string | null;
  readonly clinicAssociation: string | null;
  readonly specialization: string | null;
  /** Paise, with the Clinic default applied where the doctor has no fee (§3.2). */
  readonly consultationFee: number;
}

function toPublicDoctorDto(row: PublicDoctorRow, defaultFee: number): PublicDoctor {
  const profile = row.doctorProfile;
  if (!profile) {
    // Unreachable through every write path (inviteDoctor creates the profile in
    // the same transaction) — a data answer, not a 500, for a public caller.
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }
  return {
    id: row.id,
    fullName: row.fullName,
    qualification: profile.qualification,
    experience: profile.experience,
    clinicAssociation: profile.clinicAssociation,
    specialization: profile.specialization,
    consultationFee: profile.consultationFee ?? defaultFee,
  };
}

/**
 * The §5 bookability rule expressed as the public list's WHERE clause. Kept
 * inline with a pointer to `isBookable` rather than a second helper so the two
 * cannot disagree: one rule, two spellings of it is exactly how a suspended
 * doctor slips back onto the site.
 */
const bookableFilter = {
  role: $Enums.UserRole.DOCTOR,
  doctorProfile: {
    verificationStatus: $Enums.DoctorVerificationStatus.VERIFIED,
    suspendedAt: null,
  },
} as const;

const doctorSelect = {
  id: true,
  fullName: true,
  doctorProfile: true,
} as const;

async function loadDefaultFee(): Promise<number> {
  const clinic = await prisma.clinic.findFirst({ select: { defaultConsultationFee: true } });
  return clinic?.defaultConsultationFee ?? 0;
}

export async function listPublicDoctors(): Promise<PublicDoctor[]> {
  const [defaultFee, users] = await Promise.all([
    loadDefaultFee(),
    prisma.user.findMany({
      where: bookableFilter,
      select: doctorSelect,
      // Public display order, not the roster's recency order.
      orderBy: { fullName: "asc" },
    }),
  ]);
  return users.map((user) => toPublicDoctorDto(user, defaultFee));
}

export async function getPublicDoctor(doctorId: string): Promise<PublicDoctor> {
  const [defaultFee, user] = await Promise.all([
    loadDefaultFee(),
    prisma.user.findUnique({
      where: { id: doctorId },
      select: doctorSelect,
    }),
  ]);

  // One generic miss: a suspended, unverified, archived or never-existed
  // doctor all answer 404, exactly as §26's "suspended hidden" requires — a
  // 403 would confirm that a hidden doctor exists.
  if (!user || !user.doctorProfile || user.doctorProfile.verificationStatus !== $Enums.DoctorVerificationStatus.VERIFIED || user.doctorProfile.suspendedAt !== null) {
    throw new AppError(404, "DOCTOR_NOT_FOUND", "Doctor not found");
  }

  return toPublicDoctorDto(user, defaultFee);
}

export interface PublicClinic {
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
}

export interface PublicClinicStats {
  /** Verified and not suspended — the same `bookableFilter` the list uses. */
  readonly doctorCount: number;
  /** Distinct non-empty specializations among bookable doctors (§30). */
  readonly specializationCount: number;
}

export interface PublicClinicResult {
  readonly clinic: PublicClinic;
  /** §26's "truthful statistics … derived from real data". No invented metrics. */
  readonly stats: PublicClinicStats;
}

export async function getPublicClinic(): Promise<PublicClinicResult> {
  const [clinic, doctorCount, specializations] = await Promise.all([
    prisma.clinic.findFirst({ select: { name: true, timezone: true, currency: true } }),
    prisma.user.count({ where: bookableFilter }),
    prisma.doctorProfile.findMany({
      where: {
        verificationStatus: $Enums.DoctorVerificationStatus.VERIFIED,
        suspendedAt: null,
        specialization: { not: null },
      },
      select: { specialization: true },
      distinct: ["specialization"],
    }),
  ]);

  if (!clinic) {
    throw new AppError(500, "CLINIC_NOT_CONFIGURED", "Clinic settings are not configured");
  }

  return {
    clinic: { name: clinic.name, timezone: clinic.timezone, currency: clinic.currency },
    stats: { doctorCount, specializationCount: specializations.length },
  };
}