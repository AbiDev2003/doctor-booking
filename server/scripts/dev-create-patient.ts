// Local development helper — create a test patient with a password you choose.
//  npx tsx scripts/dev-create-patient.ts patient@example.test "Test Patient" 9876543210 "test-password"
// This creates the patient and profile together, and marks the email verified so local testing does not depend on email delivery. It is not for production.

import "dotenv/config";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/auth.js";
import {
  normalizePhoneToE164,
  DEFAULT_COUNTRY_CALLING_CODE,
} from "../src/lib/time.js";
import { newPasswordSchema } from "../src/shared/validation/auth.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "DATABASE_URL is not set. Run this from server/ with server/.env present.",
  );
  process.exit(1);
}

if (config.NODE_ENV === "production") {
  console.error(
    "Refusing to run: dev-create-patient creates a local test account.",
  );
  process.exit(1);
}

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  phone: z.string().trim().min(1, "Phone number is required").max(32),
  password: newPasswordSchema,
});

const parsed = inputSchema.safeParse({
  email: process.argv[2],
  fullName: process.argv[3],
  phone: process.argv[4],
  password: process.argv[5],
});

if (!parsed.success) {
  console.error(
    'Usage: npx tsx scripts/dev-create-patient.ts <email> "<full name>" <phone> "<password>"',
  );
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "input"}: ${issue.message}`);
  }
  process.exit(1);
}

const { email, fullName, phone: rawPhone, password } = parsed.data;
const phone = normalizePhoneToE164(rawPhone, DEFAULT_COUNTRY_CALLING_CODE);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

try {
  const [existingUser, existingProfile] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.patientProfile.findUnique({
      where: { phone },
      select: { id: true },
    }),
  ]);

  if (existingUser !== null) {
    console.error(`An account with ${email} already exists. Nothing changed.`);
    process.exitCode = 1;
  } else if (existingProfile !== null) {
    console.error(
      `A patient with phone ${phone} already exists. Nothing changed.`,
    );
    process.exitCode = 1;
  } else {
    const user = await prisma.user.create({
      data: {
        role: "PATIENT",
        fullName,
        email,
        passwordHash: await hashPassword(password),
        emailVerifiedAt: new Date(),
        patientProfile: {
          create: {
            phone,
            phoneVerified: false,
            isProvisional: false,
          },
        },
      },
      select: { id: true },
    });

    console.log(
      `PATIENT ${email} created (id ${user.id}). Sign in at ${config.CLIENT_URL}/login`,
    );
  }
} finally {
  await prisma.$disconnect();
}
