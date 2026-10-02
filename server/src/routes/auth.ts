import { Router } from "express";
import type { Request } from "express";
import { config } from "../config.js";
import { registerSchema, verifyEmailSchema } from "../schemas/auth.js";
import { registerPatient, verifyEmail } from "../services/auth.service.js";

export const authRouter = Router();

function getClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw.length > 0) {
    const first = raw.split(",")[0]?.trim();
    return first ? first : null;
  }
  return req.ip ?? null;
}

authRouter.post("/register", async (req, res, next) => {
  try {
    const parsed = registerSchema.parse(req.body);
    const ip = getClientIp(req);

    const result = await registerPatient({
      email: parsed.email,
      password: parsed.password,
      fullName: parsed.fullName,
      phone: parsed.phone,
      ip,
    });

    const verificationUrl = `${config.CLIENT_URL}/verify-email?token=${result.rawToken}`;
    req.log.info({ userId: result.userId }, `Email verification link: ${verificationUrl}`);

    res.status(201).json({
      message: "Registration successful. Please verify your email.",
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/verify-email", async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const parsed = verifyEmailSchema.parse({ token });
    await verifyEmail(parsed.token);
    res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/verify-email", async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.parse(req.body);
    await verifyEmail(parsed.token);
    res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    next(err);
  }
});
