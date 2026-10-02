import { z } from "zod";

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email address"),
  password: z
    .string()
    .trim()
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
