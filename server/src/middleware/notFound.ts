import type { RequestHandler } from "express";
import { sanitizeRequestUrl } from "../lib/logger.js";
import { getRequestId } from "./requestId.js";

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${sanitizeRequestUrl(req.originalUrl)}`,
      requestId: getRequestId(res),
    },
  });
};
