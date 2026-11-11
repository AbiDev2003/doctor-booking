// Local development helper — set a password for an account that already exists,
// without going through the email-based §6.2 reset flow.
//
//   npx tsx scripts/dev-set-password.ts owner@example.com "new-password"
//
// Why this exists: §5.1 seeds the admin, the doctors and the staff user with
// `passwordHash = null` on purpose — the "not yet claimed" state — so there is
// no built-in demo credential to look up. The supported claim path is the
// forgot-password link, but that needs working email delivery, and Resend's
// sandbox sender (`onboarding@resend.dev`) can only reach the address on the
// Resend account. Locally that often means there is no inbox to read.
//
// This is a DEV tool. It refuses to run when NODE_ENV=production, and it is not
// wired into the app. It does not bypass a runtime gate: it writes the same
// bcrypt hash that registration/reset write, then revokes the account's live
// refresh tokens so anyone holding an old session is signed out — the same
// side effect §6.2's reset has.

import "dotenv/config";
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
  console.error("Refusing to run: dev-set-password writes a known credential and is local-only.");
  process.exit(1);
}

const [rawEmail, rawPassword] = process.argv.slice(2);

if (rawEmail === undefined || rawPassword === undefined) {
  console.error('Usage: npx tsx scripts/dev-set-password.ts <email> "<password>"');
  process.exit(1);
}

// Same rule the API uses for a new password, so this tool cannot mint a
// password that the login form or a later reset would refuse.
const password = newPasswordSchema.parse(rawPassword);
const email = rawEmail.trim().toLowerCase();

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

try {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, isDeactivated: true, passwordHash: true },
  });

  if (user === null) {
    console.error(`No account with email ${email}. Run \`npm run db:seed\` first, or check the address.`);
    process.exitCode = 1;
  } else if (user.isDeactivated) {
    console.error(`Account ${email} is deactivated; a password would not let it sign in.`);
    process.exitCode = 1;
  } else {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    console.log(
      `Password ${user.passwordHash === null ? "set (claimed)" : "reset"} for ${user.role} ${email}. Sign in at ${config.CLIENT_URL}/login`,
    );
  }
} finally {
  await prisma.$disconnect();
}
