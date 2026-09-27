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
  JWT_ACCESS_SECRET: z.string().min(32, "required — at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "required — at least 32 characters"),
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, "must look like 30s, 15m, 2h or 7d"),
  RESEND_API_KEY: optionalSecret,
  RAZORPAY_KEY_ID: optionalSecret,
  RAZORPAY_KEY_SECRET: optionalSecret,
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

export type Config = typeof config;
