import { pino } from "pino";

/**
 * Query parameters whose VALUE is a credential.
 *
 * Email links carry the token in the query string (`/verify-email?token=...`),
 * so the request logger would otherwise write a live single-use credential into
 * the access log — the same leak the route-level log lines had, arriving through
 * a different door. The list is explicit rather than a regex because a redacted
 * `?page=2` helps nobody and a missed `?token=` is a security incident.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "otp",
  "code",
  "access_token",
  "refresh_token",
  "signature",
]);

/** Replace credential query values while keeping the rest of the URL readable. */
export function sanitizeRequestUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const params = new URLSearchParams(url.slice(queryStart + 1));
  let changed = false;

  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, "REDACTED");
      changed = true;
    }
  }

  return changed ? `${path}?${params.toString()}` : url;
}

export const logger = pino({
  level: "info",
  base: { service: "doctor-booking-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers[\"set-cookie\"]",
      "password",
      "*.password",
      "token",
      "*.token",
      "rawToken",
      "*.rawToken",
      "otp",
      "*.otp",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
    ],
    censor: "[redacted]",
  },
});
