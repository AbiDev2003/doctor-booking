import { $Enums } from "../generated/prisma/client.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { hashPassword, generateToken, hashToken, getEmailVerificationExpiry } from "../lib/auth.js";
import { normalizePhoneToE164, DEFAULT_COUNTRY_CALLING_CODE } from "../lib/time.js";

/**
 * Either the root client or an interactive-transaction client. Both expose the
 * same delegates, so helpers that write accept one or the other and stay
 * correct when called from inside $transaction — reaching for the root `prisma`
 * inside a transaction uses a second connection, which is neither atomic nor
 * able to see the transaction's uncommitted rows.
 */
type DbClient = PrismaClient | Prisma.TransactionClient;

export interface RegisterPatientInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  ip?: string | null;
}

export interface EmailVerificationTokenResult {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function createEmailVerificationToken(
  client: DbClient,
  userId: string,
  ip?: string | null,
): Promise<EmailVerificationTokenResult> {
  const rawToken = generateToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = getEmailVerificationExpiry();

  await client.authToken.create({
    data: {
      userId,
      purpose: $Enums.AuthTokenPurpose.EMAIL_VERIFICATION,
      tokenHash,
      expiresAt,
      consumedAt: null,
      ip: ip ?? null,
    },
  });

  return { rawToken, tokenHash, expiresAt };
}

export async function registerPatient(input: RegisterPatientInput): Promise<{ userId: string; rawToken: string }> {
  const email = input.email.toLowerCase().trim();
  const normalizedPhone = normalizePhoneToE164(input.phone, DEFAULT_COUNTRY_CALLING_CODE);

  const existingUserByEmail = await prisma.user.findUnique({
    where: { email },
  });
  if (existingUserByEmail) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Email already registered");
  }

  const existingProfileByPhone = await prisma.patientProfile.findUnique({
    where: { phone: normalizedPhone },
  });
  if (existingProfileByPhone) {
    throw new AppError(409, "PHONE_ALREADY_EXISTS", "Phone number already registered");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        role: $Enums.UserRole.PATIENT,
        fullName: input.fullName.trim(),
        email,
        passwordHash,
        emailVerifiedAt: null,
        pendingEmail: null,
        isDeactivated: false,
      },
    });

    await tx.patientProfile.create({
      data: {
        userId: user.id,
        phone: normalizedPhone,
        phoneVerified: false,
        isProvisional: false,
      },
    });

    const token = await createEmailVerificationToken(tx, user.id, input.ip ?? null);

    return { userId: user.id, rawToken: token.rawToken };
  });

  return result;
}

export async function verifyEmail(token: string): Promise<{ userId: string; email: string | null }> {
  const tokenHash = hashToken(token.trim());
  const now = new Date();

  const authToken = await prisma.authToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!authToken) {
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  }

  if (authToken.purpose !== $Enums.AuthTokenPurpose.EMAIL_VERIFICATION) {
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  }

  if (authToken.consumedAt !== null) {
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  }

  if (authToken.expiresAt < now) {
    throw new AppError(400, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired verification token");
  }

  if (authToken.user.isDeactivated) {
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  await prisma.$transaction(async (tx) => {
    await tx.authToken.update({
      where: { id: authToken.id },
      data: { consumedAt: now },
    });

    if (authToken.user.emailVerifiedAt === null) {
      await tx.user.update({
        where: { id: authToken.userId },
        data: { emailVerifiedAt: now },
      });
    }
  });

  return {
    userId: authToken.userId,
    email: authToken.user.email,
  };
}

/**
 * Throws if the user's email is not verified.
 * Used to block booking until verified (§6.3).
 */
export async function ensureEmailVerified(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true, isDeactivated: true },
  });

  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }

  if (user.isDeactivated) {
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "Account is deactivated");
  }

  if (user.emailVerifiedAt === null) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Email not verified");
  }
}
