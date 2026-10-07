import { isIP } from "node:net";
import type { Request } from "express";

/**
 * The client address for the `auth_attempts` / `refresh_tokens` / `audit_logs`
 * `ip` columns, shared by the auth and account routers (Day 11 moved it here
 * from routes/auth.ts, where it had been private since Day 7: the account
 * routes re-authenticate with a password and would otherwise carry a second
 * copy of the same `inet`-safety logic, and two copies of a security-relevant
 * parser is two chances for one to drift).
 *
 * It reads `req.ip`, never `x-forwarded-for` directly: `app.ts` sets
 * `trust proxy`, which is what makes `req.ip` the real client rather than the
 * proxy's address. Reading the header here instead would take whatever the
 * caller sent — and Day 9's per-IP lockout is keyed on exactly this value.
 *
 * The result is validated because those columns are `inet`: an address
 * Postgres cannot parse fails the insert and turns a login into a 500. An
 * unparseable address is not worth failing a request over, so it becomes null
 * (and then the `UNKNOWN_IP_KEY` shared bucket, rateLimit.service.ts).
 */
export function getClientIp(req: Request): string | null {
  const raw = req.ip ?? req.socket.remoteAddress;
  if (!raw) return null;

  const candidate = raw.replace(/^\[/, "").replace(/\]$/, "").split("%")[0] ?? "";
  return isIP(candidate) > 0 ? candidate : null;
}
