import "dotenv/config";
import { z } from "zod";

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(blankAsUndefined, z.string().min(1).optional());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "required — the PostgreSQL connection string"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  CLIENT_URL: z.url("must be a valid URL, e.g. http://localhost:5173"),
  APP_TIMEZONE: z.string().min(1, "required — IANA zone used for display only"),
  // Only two things read this: the refresh cookie's `secure` flag and
  // `sameSite`. Both must differ between localhost and a real deployment —
  // see lib/cookies.ts for why SameSite breaks on separate subdomains.
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  JWT_ACCESS_SECRET: z.string().min(32, "required — at least 32 characters"),
  // No refresh secret exists, and its absence is deliberate. A refresh token is
  // an opaque random string stored as SHA-256, not a JWT: it must be revocable,
  // which a self-contained token cannot be (§6.3). Nothing signs or verifies it
  // beyond that hash lookup, so a second secret would be a var every operator
  // sets, rotates and wonders about — with no reader.
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, "must look like 30s, 15m, 2h or 7d"),
  // Seed inputs, read by prisma/seed.ts from Day 6. Optional so the app boots
  // without them — nothing in the request path needs any of them.
  //
  // CLINIC_OWNER_NAME joins CLINIC_OWNER_EMAIL because `User.fullName` is required
  // and the seeded owner is a User (§24). §5.1 reads these from the environment
  // rather than a fixture literal, so the first admin is never a hard-coded name.
  CLINIC_OWNER_EMAIL: z.email().optional(),
  CLINIC_OWNER_NAME: z.string().min(1, "required when CLINIC_OWNER_EMAIL is set — User.fullName is not null").optional(),
  SEED_PATIENT_PASSWORD: optionalSecret,
  RESEND_API_KEY: optionalSecret,
  RAZORPAY_KEY_ID: optionalSecret,
  RAZORPAY_KEY_SECRET: optionalSecret,
})
  // The owner is a single row, so HALF of it is not a valid configuration, in
  // either direction: an email with no name fails at the `users.full_name` NOT
  // NULL constraint in Day 6, and a name with no email has nothing to attach the
  // account to. Both are much later and much less obvious places to learn a
  // value is missing, and the asymmetry that matters is that both halves are
  // optional TOGETHER — nothing in the request path needs either one.
  .refine((env) => (env.CLINIC_OWNER_EMAIL === undefined) === (env.CLINIC_OWNER_NAME === undefined), {
    path: ["CLINIC_OWNER_NAME"],
    message: "must be set together with CLINIC_OWNER_EMAIL — set both, or neither",
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  console.error(
    `Invalid environment configuration:\n${details}\n\n` +
      "Copy server/.env.example to server/.env and fill in the missing values.",
  );
  process.exit(1);
}

export const config = parsed.data;

// No caller today. This one is PRE-EXISTING Day 4 rather than something Day 5
// added, and unlike the two commented-out exports in src/lib/time.ts it is not
// redundant — a type alias for the parsed config shape is a reasonable thing for
// a config module to export, and a later phase may well annotate against it.
// Commented out only because it is currently unreferenced; safe to restore
// without thinking, and a type export cannot affect runtime either way.
//
// export type Config = typeof config;
