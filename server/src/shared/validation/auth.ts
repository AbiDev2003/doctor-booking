import { z } from "zod";

/**
 * Day 34 — the auth request schemas shared by the API and the browser.
 *
 * The server still parses every request; the client uses the same objects for
 * `react-hook-form` validation so a rejected password length or malformed email
 * is caught before a round trip, with one source of truth for the rule.
 */

/**
 * The rule for a NEW password, shared by registration, reset and claim.
 * No `.trim()`: a password is used exactly as typed, and trimming it at one
 * end only would silently change the secret. Whitespace is legal.
 */
export const newPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must not exceed 128 characters");

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  password: newPasswordSchema,
  fullName: z
    .string()
    .trim()
    .min(1, "Full name is required")
    .max(200, "Full name must not exceed 200 characters"),
  phone: z
    .string()
    .trim()
    .min(1, "Phone number is required")
    .max(32, "Phone number must not exceed 32 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1, "Token is required"),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  // No complexity rules and no trim — only length, and the same password the
  // user registered with. The floor is 1 rather than registerSchema's 8 so a
  // stale client is told the password is wrong rather than that it is too
  // short. Anything stricter belongs in a deliberate decision, not a schema edit.
  password: z
    .string()
    .min(1, "Password is required")
    .max(128, "Password must not exceed 128 characters"),
});

export type LoginInputShape = z.infer<typeof loginSchema>;

/**
 * §6.2's request body: the address to try, and which of the two methods to
 * send.
 *
 * `method` defaults to `"link"` — the plan lists the link first, and a client
 * that sends only the email (or any pre-Day-11 client, of which there are
 * none yet) gets method 1 rather than a validation error. The endpoint's
 * RESPONSE is identical for every combination (route-level, §6.2 genericity);
 * `method` only decides which artifact is issued.
 */
export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  method: z.enum(["link", "otp"]).default("link"),
});

export type ForgotPasswordInputShape = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  // Accepts either artifact: the 64-hex link token from the emailed URL or the
  // 6-digit OTP typed into the portal. The two are told apart later, by shape
  // (`looksLikeOtp`), because they are one AuthToken mechanic (§6.2) and the
  // audit row records which one was used.
  token: z.string().trim().min(1, "Token is required"),
  // Identical rules to registerSchema, deliberately: a reset must not be able
  // to mint a password registration would have refused — two validators with
  // two answers for one secret is how "it let me set this, why won't it accept
  // it" tickets start.
  password: newPasswordSchema,
});

export type ResetPasswordInputShape = z.infer<typeof resetPasswordSchema>;

/**
 * §5.1 account claim (Day 12) — the invitation's password half. Lives beside
 * resetPassword because it IS a reset of the same kind: one link token, one
 * password validator, same rules by the reasoning above. The distinction the
 * plan insists on is in the TOKEN's purpose and lifetime (`ACCOUNT_CLAIM`,
 * `ACCOUNT_CLAIM_TTL`, decided D1/D3), not in the password policy.
 */
export const claimAccountSchema = z.object({
  token: z.string().trim().min(1, "Token is required"),
  password: newPasswordSchema,
});

export type ClaimAccountInputShape = z.infer<typeof claimAccountSchema>;
