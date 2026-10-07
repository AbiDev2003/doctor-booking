import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/appError.js";
import { getRequestId } from "./requestId.js";

/**
 * The wait a 429 should advertise, or null when there is none to report.
 *
 * Read defensively because `details` is `unknown` and is set by whichever service
 * raised the error. A `Retry-After: 0` is worse than no header at all: a
 * well-behaved client reads it as "retry immediately", turns around and is refused
 * again. So a 0 is treated as absent — the honest reading for any cap with no
 * window to measure, and a floor under a caller that passes a negative by mistake.
 *
 * The caps in `rateLimit.service.ts` all supply a real value: a windowed cap reports
 * when its window rolls over, and the OTP per-token cap reports the issued token's
 * remaining lifetime, read from `auth_tokens` in this same database. This guard is
 * the backstop for the case where a future cap has nothing honest to report, not the
 * mechanism those caps rely on.
 */
function retryAfterSeconds(details: unknown): number | null {
  if (typeof details !== "object" || details === null) {
    return null;
  }

  const value = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.ceil(value);
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = getRequestId(res);

  if (err instanceof SyntaxError && "body" in err) {
    req.log.warn("malformed JSON body");
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Request body is not valid JSON",
        requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    req.log.warn({ err }, "request validation failed");
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
        requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      req.log.error({ err, code: err.code }, "request failed");
    } else {
      req.log.warn({ err, code: err.code }, "request rejected");
    }

    // §6.3: "Blocked requests return a generic 429 with Retry-After". Set before
    // the response goes out, and only for 429 — the header means nothing on a 401
    // and would suggest a retry that cannot succeed.
    if (err.status === 429) {
      const retryAfter = retryAfterSeconds(err.details);
      if (retryAfter !== null) {
        res.setHeader("Retry-After", String(retryAfter));
      }
    }

    res.status(err.status).json({
      error: { code: err.code, message: err.message, requestId },
    });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId,
    },
  });
};
