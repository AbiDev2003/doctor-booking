import { z } from "zod";

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  // No .trim(), here or at login: a password is used exactly as typed, and
  // trimming it at one end only would silently change the secret. Whitespace
  // is a legal password character.
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must not exceed 128 characters"),
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
