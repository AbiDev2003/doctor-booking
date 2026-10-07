import { z } from "zod";

/**
 * §6.1 input schemas. The phone/password shapes deliberately match their
 * `schemas/auth.ts` cousins field for field — one rule per secret (see
 * resetPasswordSchema for why a second password validator is how "it let me
 * set this" tickets start).
 */
export const changeEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
});

export type ChangeEmailInputShape = z.infer<typeof changeEmailSchema>;

export const changePhoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(1, "Phone number is required")
    .max(32, "Phone number must not exceed 32 characters"),
  // The re-authentication factor (locked Day 11 decision: current password
  // only, no OTP alternative). Length floor 1 rather than 8, matching
  // loginSchema's reasoning: this is an EXISTING secret being confirmed, not a
  // new one being chosen — the shortest possible answer to "what is your
  // password" should be "wrong password", not "too short".
  password: z
    .string()
    .min(1, "Current password is required")
    .max(128, "Password must not exceed 128 characters"),
});

export type ChangePhoneInputShape = z.infer<typeof changePhoneSchema>;

export const deleteAccountSchema = z.object({
  password: z
    .string()
    .min(1, "Current password is required")
    .max(128, "Password must not exceed 128 characters"),
});

export type DeleteAccountInputShape = z.infer<typeof deleteAccountSchema>;
