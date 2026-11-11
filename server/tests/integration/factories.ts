import { randomUUID } from "node:crypto";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { localDateTimeToUtc } from "../../src/lib/time.js";

const CLINIC_TIMEZONE = "Asia/Kolkata";
let sequence = 0;

function uniqueSuffix(): string {
  sequence += 1;
  return `${Date.now()}-${sequence}-${randomUUID().slice(0, 8)}`;
}

function localClock(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}

function dateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createClinic(overrides: {
  name?: string;
  timezone?: string;
  defaultConsultationFee?: number;
} = {}) {
  return prisma.clinic.create({
    data: {
      name: overrides.name ?? `Test Clinic ${uniqueSuffix()}`,
      timezone: overrides.timezone ?? CLINIC_TIMEZONE,
      defaultConsultationFee: overrides.defaultConsultationFee ?? 50_000,
    },
  });
}

export function createDoctor(overrides: { email?: string; fullName?: string } = {}) {
  const suffix = uniqueSuffix();
  return prisma.user.create({
    data: {
      role: $Enums.UserRole.DOCTOR,
      fullName: overrides.fullName ?? `Test Doctor ${suffix}`,
      email: overrides.email ?? `doctor-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      doctorProfile: {
        create: {
          verificationStatus: $Enums.DoctorVerificationStatus.VERIFIED,
          qualification: "MBBS",
          licenseNumber: `TEST-${suffix}`,
          experience: "5 years",
          clinicAssociation: "Test Clinic",
          specialization: "General Medicine",
        },
      },
    },
    include: { doctorProfile: true },
  });
}

export function createPatient(overrides: {
  email?: string;
  fullName?: string;
  phone?: string;
} = {}) {
  const suffix = uniqueSuffix();
  return prisma.user.create({
    data: {
      role: $Enums.UserRole.PATIENT,
      fullName: overrides.fullName ?? `Test Patient ${suffix}`,
      email: overrides.email ?? `patient-${suffix}@example.test`,
      emailVerifiedAt: new Date(),
      patientProfile: {
        create: {
          phone: overrides.phone ?? `+919${String(sequence).padStart(9, "0")}`,
          phoneVerified: false,
          isProvisional: false,
        },
      },
    },
    include: { patientProfile: true },
  });
}

export function createSlot(
  doctorId: string,
  overrides: { date?: string; startTime?: string; endTime?: string; maxPatients?: number } = {},
) {
  const date = overrides.date ?? dateAfter(30);
  const startTime = overrides.startTime ?? "09:00";
  const endTime = overrides.endTime ?? "10:00";

  return prisma.slot.create({
    data: {
      doctorId,
      slotDate: new Date(`${date}T00:00:00.000Z`),
      startTime: localClock(startTime),
      endTime: localClock(endTime),
      startAt: localDateTimeToUtc({ date, time: startTime }, CLINIC_TIMEZONE),
      endAt: localDateTimeToUtc({ date, time: endTime }, CLINIC_TIMEZONE),
      maxPatients: overrides.maxPatients ?? 10,
    },
  });
}
