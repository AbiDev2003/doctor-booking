import "dotenv/config";
import { z } from "zod";
import { DURATION_PATTERN, durationToMs } from "./lib/duration.js";

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalSecret = z.preprocess(blankAsUndefined, z.string().min(1).optional());

const DURATION_MESSAGE = "must look like 30s, 15m, 2h or 7d";

/**
 * Counts are `.int().positive()` and never a bare `z.coerce.number()`.
 *
 * `PORT` gets away with coercion only because `.positive()` rejects the `0` an
 * empty string coerces into (`z.coerce.number()` on `""` is 0, not a parse
 * failure). A limit without that floor can be zeroed by blanking the line in
 * `.env`, and nothing complains at boot: `LOCKOUT_FAILURES=0` reads plausibly as
 * "lock out immediately" and is really "the threshold is never reached", i.e. the
 * lockout is off with no trace. `.positive()` also rejects `0` typed by hand, so
 * there is no value at all that disables a control §6.3 always wants on.
 *
 * `blankAsUndefined` covers the other route to the same hole: a blank line
 * becomes "unset", which falls back to the §6.3 default rather than to nothing.
 */
const positiveCount = (defaultValue: number) =>
  z.preprocess(blankAsUndefined, z.coerce.number().int().positive().default(defaultValue));

/** See `positiveCount` for why the preprocess comes first. */
const duration = (defaultValue: string) =>
  z.preprocess(blankAsUndefined, z.string().regex(DURATION_PATTERN, DURATION_MESSAGE).default(defaultValue));

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
    .regex(DURATION_PATTERN, DURATION_MESSAGE),
  // §6.2: the password-reset link / OTP expiry — "short (default: 15 minutes,
  // configurable)". One knob for both methods, because link and OTP are one
  // AuthToken row with one expiresAt: two knobs would let an operator believe
  // the two expire differently when the column can only hold one value. It also
  // sets §6.1's EMAIL_CHANGE token expiry, deliberately — plan.md §6.2 calls
  // AuthToken "the single mechanic ... one issue/verify/expiry/rate-limit path,
  // not four", and a purpose-by-purpose expiry matrix nothing reads is how four
  // paths quietly reappear.
  PASSWORD_RESET_TTL: duration("15m"),
  // §5.1 invite claim — a SEPARATE knob from PASSWORD_RESET_TTL, and the
  // reason is human, not technical: a reset is "I am locked out right now"
  // (minutes), an invitation is "your account is waiting whenever you get to
  // it" (a day). Borrowing the 15m reset TTL would mean every doctor who does
  // not click within a quarter of an hour needs a resent invite, and the two
  // values can never be kept equal by hand because they should not be equal.
  // The token mechanics (single-use, hashed, rate-limited) are identical; only
  // the lifetime differs.
  ACCOUNT_CLAIM_TTL: duration("24h"),
  // §6.3 rate limiting. Every value is optional and defaults to the number the
  // plan fixes, so an unset variable means "the spec'd policy" rather than "no
  // policy" — production runs on defaults and .env is purely an override, which
  // is what makes a locally tuned LOCKOUT_FAILURES=2 safe to leave lying around.
  //
  // The identity pair (failures + window) is the primary §6.3 defence and the
  // only one that protects one account. The IP pair is the secondary cap against
  // sweeping across many addresses. The OTP pair is stricter than both by design.
  LOCKOUT_FAILURES: positiveCount(5),
  LOCKOUT_WINDOW: duration("15m"),
  LOCKOUT_MAX_WINDOW: duration("60m"),
  IP_ATTEMPTS_PER_WINDOW: positiveCount(20),
  IP_WINDOW: duration("1m"),
  OTP_SEND_LIMIT: positiveCount(3),
  OTP_SEND_WINDOW: duration("15m"),
  OTP_VERIFY_LIMIT: positiveCount(5),
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
  })
  // The escalation cap must not be below the base window, or the ladder inverts:
  // `LOCKOUT_WINDOW=30m` with `LOCKOUT_MAX_WINDOW=15m` clamps every level to
  // 15 minutes, so "repeated lockouts grow" is silently false and the operator
  // has no way to see it — the config loads, the lockout works, it just never
  // escalates. Both fields already report their own shape errors, so a parse
  // failure here returns true rather than throwing out of the refine and
  // replacing a precise field error with a crash.
  .refine(
    (env) => {
      try {
        return durationToMs(env.LOCKOUT_MAX_WINDOW) >= durationToMs(env.LOCKOUT_WINDOW);
      } catch {
        return true;
      }
    },
    {
      path: ["LOCKOUT_MAX_WINDOW"],
      message: "must be greater than or equal to LOCKOUT_WINDOW — the escalation cap cannot be below the base window",
    },
  );

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
