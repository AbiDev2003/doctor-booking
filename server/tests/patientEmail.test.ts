import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums, Prisma } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { attachPatientEmailSchema } from "../src/schemas/staff.js";
import { attachProvisionalPatientEmail } from "../src/services/staff/patientEmail.service.js";

const STAFF = { id: "staff-1", role: $Enums.UserRole.STAFF, name: "Sam Staff" };
interface PatientFixture {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly role: $Enums.UserRole;
  readonly isDeactivated: boolean;
  readonly patientProfile: {
    readonly phone: string;
    readonly isProvisional: boolean;
  } | null;
}

const PROVISIONAL_PATIENT = {
  id: "patient-1",
  fullName: "Pat Patient",
  email: null,
  role: $Enums.UserRole.PATIENT,
  isDeactivated: false,
  patientProfile: {
    phone: "+919876543210",
    isProvisional: true,
  },
} satisfies PatientFixture;

interface TransactionFixture {
  readonly patient?: PatientFixture | null;
  readonly takenEmail?: boolean;
  readonly updateError?: Error;
}

function installTransaction(fixture: TransactionFixture = {}) {
  const patient = fixture.patient === undefined ? PROVISIONAL_PATIENT : fixture.patient;
  let updateData: unknown;
  let emailLookup: unknown;
  let auditEntry: unknown;
  let updateCount = 0;
  let auditCount = 0;
  let uniqueLookupCount = 0;
  let transactionCount = 0;

  const tx = {
    user: {
      findUnique: async () => patient,
      findFirst: async (args: unknown) => {
        emailLookup = args;
        uniqueLookupCount += 1;
        return fixture.takenEmail ? { id: "another-user" } : null;
      },
      update: async (args: { data: unknown }) => {
        updateData = args.data;
        updateCount += 1;
        if (fixture.updateError !== undefined) throw fixture.updateError;
        const data = args.data as { email: string };
        return { id: PROVISIONAL_PATIENT.id, fullName: PROVISIONAL_PATIENT.fullName, email: data.email };
      },
    },
    auditLog: {
      create: async (args: { data: unknown }) => {
        auditEntry = args.data;
        auditCount += 1;
      },
    },
  };

  return {
    get auditCount() {
      return auditCount;
    },
    get auditEntry() {
      return auditEntry;
    },
    get emailLookup() {
      return emailLookup;
    },
    get uniqueLookupCount() {
      return uniqueLookupCount;
    },
    get updateCount() {
      return updateCount;
    },
    get updateData() {
      return updateData;
    },
    get transactionCount() {
      return transactionCount;
    },
    runTransaction: async <T>(operation: (client: Prisma.TransactionClient) => Promise<T>) => {
      transactionCount += 1;
      return operation(tx as unknown as Prisma.TransactionClient);
    },
  };
}

function expectAppError(error: unknown, status: number, code: string): void {
  assert.ok(error instanceof AppError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
}

describe("attachProvisionalPatientEmail", () => {
  it("validates and normalizes email input at the route schema boundary", () => {
    assert.equal(
      attachPatientEmailSchema.parse({ email: "  PATIENT@EXAMPLE.COM " }).email,
      "patient@example.com",
    );
    assert.throws(() => attachPatientEmailSchema.parse({ email: "not-an-email" }));
    assert.throws(() => attachPatientEmailSchema.parse({ email: "" }));
  });

  it("normalizes the address, updates only the email, and audits in the same transaction", async () => {
    const tx = installTransaction();

    const result = await attachProvisionalPatientEmail({
      actor: STAFF,
      patientId: PROVISIONAL_PATIENT.id,
      email: "  PATIENT@EXAMPLE.COM ",
      ip: "192.0.2.1",
      requestId: "request-1",
    }, tx.runTransaction);

    assert.deepEqual(result, {
      id: PROVISIONAL_PATIENT.id,
      fullName: PROVISIONAL_PATIENT.fullName,
      phone: PROVISIONAL_PATIENT.patientProfile.phone,
      email: "patient@example.com",
      isProvisional: true,
    });
    assert.deepEqual(tx.updateData, { email: "patient@example.com" });
    assert.deepEqual(tx.emailLookup, {
      where: {
        id: { not: PROVISIONAL_PATIENT.id },
        OR: [{ email: "patient@example.com" }, { pendingEmail: "patient@example.com" }],
      },
      select: { id: true },
    });
    assert.equal(tx.auditCount, 1);
    assert.deepEqual(tx.auditEntry, {
      action: "PATIENT_EMAIL_ATTACHED",
      targetType: "user",
      targetId: PROVISIONAL_PATIENT.id,
      actorId: STAFF.id,
      actorRole: STAFF.role,
      actorName: STAFF.name,
      reason: null,
      ip: "192.0.2.1",
      requestId: "request-1",
      before: { email: null },
      after: { email: "patient@example.com", source: "desk_walk_in" },
    });
  });

  it("allows an admin to attach an email to a provisional patient", async () => {
    const tx = installTransaction();
    const result = await attachProvisionalPatientEmail({
      actor: { id: "admin-1", role: $Enums.UserRole.ADMIN, name: "Ada Admin" },
      patientId: PROVISIONAL_PATIENT.id,
      email: "patient@example.com",
    }, tx.runTransaction);

    assert.equal(result.email, "patient@example.com");
    assert.equal(tx.auditCount, 1);
  });

  it("refuses roles other than staff and admin before opening a transaction", async () => {
    const patientActor = { ...STAFF, role: $Enums.UserRole.PATIENT };
    const tx = installTransaction();

    await assert.rejects(
      attachProvisionalPatientEmail({
        actor: patientActor,
        patientId: PROVISIONAL_PATIENT.id,
        email: "patient@example.com",
      }, tx.runTransaction),
      (error: unknown) => {
        expectAppError(error, 403, "FORBIDDEN");
        return true;
      },
    );
    assert.equal(tx.transactionCount, 0);
  });

  it("returns not found when the target is missing or is not a patient", async () => {
    for (const patient of [
      null,
      { ...PROVISIONAL_PATIENT, role: $Enums.UserRole.DOCTOR },
    ]) {
      const tx = installTransaction({ patient });
      await assert.rejects(
        attachProvisionalPatientEmail({
          actor: STAFF,
          patientId: PROVISIONAL_PATIENT.id,
          email: "patient@example.com",
        }, tx.runTransaction),
        (error: unknown) => {
          expectAppError(error, 404, "PATIENT_NOT_FOUND");
          return true;
        },
      );
      assert.equal(tx.uniqueLookupCount, 0);
    }
  });

  it("refuses claimed or deactivated patient records", async () => {
    for (const [patient, code] of [
      [{ ...PROVISIONAL_PATIENT, patientProfile: { ...PROVISIONAL_PATIENT.patientProfile, isProvisional: false } }, "PATIENT_NOT_PROVISIONAL"],
      [{ ...PROVISIONAL_PATIENT, isDeactivated: true }, "PATIENT_DEACTIVATED"],
    ] as const) {
      const tx = installTransaction({ patient });
      await assert.rejects(
        attachProvisionalPatientEmail({
          actor: STAFF,
          patientId: PROVISIONAL_PATIENT.id,
          email: "patient@example.com",
        }, tx.runTransaction),
        (error: unknown) => {
          expectAppError(error, 409, code);
          return true;
        },
      );
      assert.equal(tx.uniqueLookupCount, 0);
    }
  });

  it("rejects an unchanged or already-owned email without updating or auditing", async () => {
    const unchanged = installTransaction({
      patient: { ...PROVISIONAL_PATIENT, email: "patient@example.com" },
    });
    await assert.rejects(
      attachProvisionalPatientEmail({
        actor: STAFF,
        patientId: PROVISIONAL_PATIENT.id,
        email: "PATIENT@example.com",
      }, unchanged.runTransaction),
      (error: unknown) => {
        expectAppError(error, 409, "EMAIL_UNCHANGED");
        return true;
      },
    );
    assert.equal(unchanged.updateCount, 0);
    assert.equal(unchanged.auditCount, 0);
    const taken = installTransaction({ takenEmail: true });
    await assert.rejects(
      attachProvisionalPatientEmail({
        actor: STAFF,
        patientId: PROVISIONAL_PATIENT.id,
        email: "taken@example.com",
      }, taken.runTransaction),
      (error: unknown) => {
        expectAppError(error, 409, "EMAIL_ALREADY_EXISTS");
        return true;
      },
    );
    assert.equal(taken.updateCount, 0);
    assert.equal(taken.auditCount, 0);
  });

  it("maps a concurrent unique-email conflict to a 409", async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    const tx = installTransaction({ updateError: uniqueError });

    await assert.rejects(
      attachProvisionalPatientEmail({
        actor: STAFF,
        patientId: PROVISIONAL_PATIENT.id,
        email: "raced@example.com",
      }, tx.runTransaction),
      (error: unknown) => {
        expectAppError(error, 409, "EMAIL_ALREADY_EXISTS");
        return true;
      },
    );
    assert.equal(tx.auditCount, 0);
  });
});
