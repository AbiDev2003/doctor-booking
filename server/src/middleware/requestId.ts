import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestHandler, Response } from "express";
import type { ReqId } from "pino-http";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function genRequestId(req: IncomingMessage): ReqId {
  const header = req.headers["x-request-id"];
  const candidate = Array.isArray(header) ? header[0] : header;

  return typeof candidate === "string" && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : randomUUID();
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = req.id;
  const value = typeof id === "string" ? id : String(id);

  res.locals.requestId = value;
  res.setHeader("x-request-id", value);

  next();
};

export function getRequestId(res: Response): string {
  const value: unknown = res.locals.requestId;
  return typeof value === "string" ? value : "unknown";
}
