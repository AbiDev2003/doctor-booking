// Local development helper — create (or re-credential) a test ADMIN or STAFF
// account with a password you choose.
//
//   npx tsx scripts/dev-create-account.ts dummystaff@gmail.com "Dummy Staff" STAFF dummystaff2003
//
// Why this exists: the app deliberately has no self-registration for privileged
// roles (§5.1), and the seeded staff/admin rows are created with
// `passwordHash = null` so there is no documented credential to log in with.
// The supported claim path is the invite/reset link, which needs working email
// delivery — the Resend sandbox can only reach its own account address. This is
// the offline equivalent for local testing.
//
// ADMIN and STAFF only: DOCTOR needs a DoctorProfile and PATIENT needs a
// PatientProfile (unique phone, etc.), so those two come from the seed or a real
// invitation rather than from this tool.
//
// Re-running is safe: an existing account with the same role gets its password
// reset and its live refresh tokens revoked (the same side effect §6.2's reset
// has). A role mismatch is refused instead of silently promoting/demoting.
//
// DEV tool: refuses to run when NODE_ENV=production.

import "dotenv/config";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/auth.js";
import { newPasswordSchema } from "../src/shared/validation/auth.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

if (config.NODE_ENV === "production") {
  console.error("Refusing to run: dev-create-account writes a known credential and is local-only.");
  process.exit(1);
}

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  role: z.enum(["ADMIN", "STAFF"]),
  password: newPasswordSchema,
});

const parsed = inputSchema.safeParse({
  email: process.argv[2],
  fullName: process.argv[3],
  role: process.argv[4],
  password: process.argv[5],
});

if (!parsed.success) {
  console.error('Usage: npx tsx scripts/dev-create-account.ts <email> "<full name>" <ADMIN|STAFF> "<password>"');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "input"}: ${issue.message}`);
  }
  process.exit(1);
}

const { email, fullName, role, password } = parsed.data;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

try {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, isDeactivated: true },
  });

  if (existing !== null && existing.role !== role) {
    console.error(`An account with ${email} already exists with role ${existing.role}, not ${role}. Nothing changed.`);
    process.exitCode = 1;
  } else if (existing !== null && existing.isDeactivated) {
    console.error(`Account ${email} is deactivated; a password would not let it sign in. Nothing changed.`);
    process.exitCode = 1;
  } else {
    const passwordHash = await hashPassword(password);
    const now = new Date();

    const user =
      existing !== null
        ? await prisma.user.update({
            where: { id: existing.id },
            data: { passwordHash, fullName, emailVerifiedAt: now },
            select: { id: true },
          })
        : await prisma.user.create({
            data: { role, fullName, email, passwordHash, emailVerifiedAt: now },
            select: { id: true },
          });

    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });

    console.log(
      `${role} ${email} ${existing === null ? "created" : "password reset"} (id ${user.id}). Sign in at ${config.CLIENT_URL}/login`,
    );
  }
} finally {
  await prisma.$disconnect();
}
