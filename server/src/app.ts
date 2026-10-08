import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { genRequestId, requestId } from "./middleware/requestId.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { accountRouter } from "./routes/account.js";
import { doctorsRouter, staffRouter } from "./routes/doctors.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  // One proxy hop. `req.ip` is then the address the nearest proxy reported,
  // which is the only value Day 9's per-IP lockout may key on — Express
  // defaults to false, where `req.ip` is the proxy's own address and every
  // request shares one identity. `true` would be the opposite mistake: it
  // hands `req.ip` to the leftmost, caller-supplied X-Forwarded-For entry.
  app.set("trust proxy", 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: genRequestId,
      customProps: (req) => ({ requestId: req.id }),

      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
      },
    }),
  );
  app.use(requestId);

  app.use(cors({ origin: config.CLIENT_URL, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  // Reads the refresh cookie on /auth/refresh and /auth/logout. Setting and
  // clearing are handled by lib/cookies.ts via Express's own res.cookie.
  app.use(cookieParser());

  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/auth", authRouter);
  // §6.1 account management, same prefix: identity endpoints sharing the
  // auth router's §6.3 guard (registered on the router itself, not here) and
  // the lockout-backed password checks behind it. Mounted after the auth
  // router only because it adds routes rather than intercepting any.
  app.use("/api/v1/auth", accountRouter);
  // §5/§5.2 doctor lifecycle + §5.1 staff invitation (Day 12). Two mounts for
  // two prefixes — see routes/doctors.ts for why both live in one file.
  app.use("/api/v1/doctors", doctorsRouter);
  app.use("/api/v1/staff", staffRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
