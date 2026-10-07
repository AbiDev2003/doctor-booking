import { MemoryStore, rateLimit } from "express-rate-limit";
import { rateLimitedError } from "../services/rateLimit.service.js";

/**
 * §6.3's "coarse `express-rate-limit` layer wraps auth routes as an outer guard"
 * (plan.md:481).
 *
 * **This is not the rate limiter.** The authoritative caps are in
 * `rateLimit.service.ts`, keyed on `auth_attempts` and therefore shared across
 * every process and durable across a restart. This layer exists to answer a
 * different question: how much work can be shed before a request costs a database
 * round trip and a bcrypt comparison. Two limiters that disagree resolve, in
 * practice, to the more permissive one, so this one must stay strictly looser than
 * the real policy and must never be the reason a legitimate request is refused on
 * its own. `auth_attempts.ipKey` remains the IP authority.
 *
 * That ordering is also why `keyGenerator` is left at the library default. The
 * default reads `req.ip`, which `app.set("trust proxy", 1)` (`app.ts`) has already
 * made the nearest proxy's reported address. A hand-written key would be a second
 * reader of the proxy headers, and this repo has exactly one such reader by design
 * (`getClientIp` in `routes/auth.ts`) — two is how the per-IP key starts
 * disagreeing with itself.
 *
 * The numbers are constants rather than env vars because they are not §6.3's
 * policy: they are an implementation choice about how much burst to absorb. 100 a
 * minute is roughly five times the DB-backed IP cap, so it stays out of the way of
 * a real user (a page load can legitimately produce register + verify + login +
 * refresh) while still collapsing a flood that would otherwise spend 100 bcrypt
 * operations per minute on the attacker's behalf.
 */

const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 100;

/**
 * An explicit store rather than the inherited default.
 *
 * The default *is* a MemoryStore, so this changes no behaviour today — it is here
 * so the assumption is visible in the code instead of implied by a version bump.
 * `MemoryStore` takes no window or limit here: `rateLimit()` calls `store.init()`
 * with the options below, so those are configured in exactly one place.
 *
 * It is acceptable only because the authoritative cap is DB-backed and the app is
 * single-instance (§18 keeps Redis out of the MVP). If the `auth_attempts` IP cap is
 * ever removed, this in-memory guard silently becomes the only limiter *and* is
 * per-process; that dependency should not be discoverable only by reading a
 * dependency's defaults.
 */
const burstStore = new MemoryStore();

export const authBurstGuard = rateLimit({
  windowMs: BURST_WINDOW_MS,
  limit: BURST_LIMIT,
  store: burstStore,

  // `draft-7` emits the standard `RateLimit` header. `legacyHeaders: false` stops
  // the pre-standard `X-RateLimit-*` trio, which some clients still read and which
  // duplicates it.
  standardHeaders: "draft-7",
  legacyHeaders: false,

  /**
   * Refuse through `next(AppError)` rather than the library's default handler, so
   * a 429 from this layer is byte-identical to a 429 from the DB-backed caps —
   * same body, same `requestId`, same `Retry-After`. A client cannot tell which
   * layer stopped it, which is also what stops the response from revealing whether
   * an address exists.
   */
  handler: (_req, _res, next, options) => {
    next(rateLimitedError(Math.max(1, Math.ceil(options.windowMs / 1000))));
  },
});
