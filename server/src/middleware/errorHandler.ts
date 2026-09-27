import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/appError.js";
import { getRequestId } from "./requestId.js";

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
