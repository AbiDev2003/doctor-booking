import { $Enums } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/appError.js";
import { isUniqueConstraintViolation, prisma } from "../../lib/prisma.js";
import { writeAudit } from "../audit.service.js";
import type { DeskPatientDto } from "../../schemas/staff.js";
import type { ActorContext } from "../doctors/doctor.service.js";

export interface AttachPatientEmailInput {
  readonly actor: ActorContext;
  readonly patientId: string;
  readonly email: string;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

type TransactionRunner = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/**
 * Day 34 — attach an address to a desk-created provisional patient.
 *
 * Provisional patients are the one account type the patient-facing
 * `/auth/change-email` flow cannot reach: they have no password and no session.
 * The desk already typed the address while booking, so this is the missing
 * correction path when it was omitted or mistyped.
 *
 * Deliberately narrow:
 * - STAFF/ADMIN only, and the target must still be provisional. Once a real
 *   patient claims the account, email changes go through the verified,
 *   patient-owned flow.
 * - The address is attached, not verified: staff cannot prove inbox ownership,
 *   so `emailVerifiedAt` stays null. Attaching alone does not create a login.
 * - The write and its audit row commit together, like every identity change.
 */
export async function attachProvisionalPatientEmail(
  input: AttachPatientEmailInput,
  runTransaction: TransactionRunner = (operation) => prisma.$transaction(operation),
): Promise<DeskPatientDto> {
  if (input.actor.role !== $Enums.UserRole.ADMIN && input.actor.role !== $Enums.UserRole.STAFF) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }

  const email = input.email.trim().toLowerCase();

  try {
    return await runTransaction(async (tx) => {
      const patient = await tx.user.findUnique({
        where: { id: input.patientId },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          isDeactivated: true,
          patientProfile: { select: { phone: true, isProvisional: true } },
        },
      });

      if (patient === null || patient.role !== $Enums.UserRole.PATIENT || patient.patientProfile === null) {
        throw new AppError(404, "PATIENT_NOT_FOUND", "Patient not found");
      }
      if (!patient.patientProfile.isProvisional) {
        throw new AppError(
          409,
          "PATIENT_NOT_PROVISIONAL",
          "This patient already has a login. Ask them to change their email from their account.",
        );
      }
      if (patient.isDeactivated) {
        throw new AppError(409, "PATIENT_DEACTIVATED", "That patient account is deactivated.");
      }
      if (patient.email === email) {
        throw new AppError(409, "EMAIL_UNCHANGED", "This is already the patient's email address");
      }

      const taken = await tx.user.findFirst({
        where: {
          id: { not: patient.id },
          OR: [{ email }, { pendingEmail: email }],
        },
        select: { id: true },
      });
      if (taken !== null) {
        throw new AppError(409, "EMAIL_ALREADY_EXISTS", "That email belongs to another account");
      }

      const updated = await tx.user.update({
        where: { id: patient.id },
        data: { email },
        select: { id: true, fullName: true, email: true },
      });

      await writeAudit(tx, {
        action: "PATIENT_EMAIL_ATTACHED",
        targetType: "user",
        targetId: patient.id,
        actor: { id: input.actor.id, role: input.actor.role, name: input.actor.name },
        before: { email: patient.email },
        after: { email: updated.email, source: "desk_walk_in" },
        ip: input.ip ?? null,
        requestId: input.requestId ?? null,
      });

      return {
        id: updated.id,
        fullName: updated.fullName,
        phone: patient.patientProfile.phone,
        email: updated.email,
        isProvisional: true,
      };
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "That email belongs to another account");
    }
    throw err;
  }
}
