// Local development helper — add a second ADMIN account.
//
//   npx tsx scripts/dev-create-admin.ts second-admin@example.com "Second Admin"
//
// Why a script and not an endpoint: §5.1 has no admin self-registration and no
// admin→admin invitation (POST /api/v1/staff creates STAFF only), and re-running
// the seed with a different CLINIC_OWNER_EMAIL would RENAME the existing owner
// rather than add one — the seed upserts by a fixed id. So a second admin is a
// fixture, not an app flow.
//
// The account is created in the same "not yet claimed" state the seed uses:
// `passwordHash = null`, `emailVerifiedAt` set (the address is supplied by the
// operator, not self-registered). The only way in is the §6.2 reset flow —
// which is exactly what this fixture is for: exercising /forgot-password →
// /reset-password end to end with a real inbox.
//
// DEV tool: refuses to run when NODE_ENV=production. It writes no audit row —
// a fixture insert is not an in-app action, and §20 audits actions, not seeds.

import "dotenv/config";
import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

if (config.NODE_ENV === "production") {
  console.error("Refusing to run: dev-create-admin writes a known account and is local-only.");
  process.exit(1);
}

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  fullName: z.string().trim().min(1, "Full name is required").max(200),
});

const parsed = inputSchema.safeParse({
  email: process.argv[2],
  fullName: process.argv[3],
});

if (!parsed.success) {
  console.error('Usage: npx tsx scripts/dev-create-admin.ts <email> "<full name>"');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "input"}: ${issue.message}`);
  }
  process.exit(1);
}

const { email, fullName } = parsed.data;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

try {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, passwordHash: true, isDeactivated: true },
  });

  if (existing !== null) {
    if (existing.role !== "ADMIN") {
      console.error(`An account with ${email} already exists with role ${existing.role}, not ADMIN. Nothing changed.`);
      process.exitCode = 1;
    } else {
      console.log(
        `ADMIN ${email} already exists (id ${existing.id}, ${existing.passwordHash === null ? "not yet claimed" : "password already set"}). Nothing changed.`,
      );
    }
  } else {
    const user = await prisma.user.create({
      data: {
        role: "ADMIN",
        fullName,
        email,
        emailVerifiedAt: new Date(),
        passwordHash: null,
      },
      select: { id: true },
    });

    console.log(`Created ADMIN ${fullName} <${email}> (id ${user.id}), passwordHash: null.`);
    console.log(`Next: open ${config.CLIENT_URL}/forgot-password and send a reset link to ${email}.`);
  }
} finally {
  await prisma.$disconnect();
}
