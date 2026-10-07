import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { config } from "../config.js";
import { durationToMs } from "../lib/duration.js";

/**
 * §6.3 rate limiting, backed by the `auth_attempts` table (plan.md:472-481).
 *
 * Two key types, and they defend different things. The **identity key** (the
 * normalised email) is the primary defence and the only one that protects one
 * account from being guessed. The **IP key** is a secondary volume cap that
 * guards account sweeping across many addresses and OTP email-bombing. Neither
 * subsumes the other: an attacker spraying one address from a botnet is stopped
 * only by the identity key, and a sweep across ten thousand addresses from one
 * host is stopped only by the IP key.
 *
 * Structure: every *judgment* here is a pure function over timestamps, and the
 * database is only ever asked for those timestamps. That split is what makes
 * Day 9's `[T]` tests possible without the Day 35 harness, and it keeps the part
 * that is easy to get wrong — the escalation ladder and the window boundary —
 * readable in one screen.
 *
 * Every 429 raised from this module carries the SAME message (§6.3: "responses
 * never reveal whether an address exists"), so the message cannot be used as an
 * oracle. `Retry-After` is attached by the error handler from `details`.
 */

/**
 * Bucket for a request whose client address could not be determined.
 *
 * `ip_key` is NOT NULL (`schema.prisma:1039`), and `getClientIp` returns null
 * rather than an unparseable string, because `ip` is an `inet` column and a bad
 * value would fail the insert and turn a login into a 500.
 *
 * Every unattributable request therefore lands in one shared bucket. That is the
 * safe direction: such requests are rare and are usually not a real client, so
 * capping them harder costs a legitimate caller very little. The alternative —
 * skipping the IP check when the address is unknown — would make the cap
 * trivially bypassable by arriving with a malformed `X-Forwarded-For`.
 */
export const UNKNOWN_IP_KEY = "unknown";

export type AuthAttemptPurpose = $Enums.AuthAttemptPurpose;

/** One recorded attempt, as read back for a decision. */
export interface AttemptEvent {
  readonly createdAt: Date;
}

/**
 * The generic §6.3 refusal, and the ONLY place that message is written.
 *
 * One string for the identity cap, the IP cap, both OTP caps and the coarse
 * outer guard, so nothing about which limit was hit — or whether the address
 * exists — can be inferred from the response. §6.3 requires exactly this:
 * "responses never reveal whether an address exists". Exported because the
 * middleware layer needs the identical message, and two copies of a security
 * string is two chances to leak through one of them.
 *
 * `retryAfterSeconds` of 0 means "no honest wait to report" and the error handler
 * omits the header rather than sending `Retry-After: 0`.
 */
export function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Please try again later.", {
    retryAfterSeconds,
  });
}

// ---------------------------------------------------------------------------
// Pure decision logic — no database, no clock, fully unit tested
// ---------------------------------------------------------------------------

/** Result of a fixed-size window cap: the IP key and both OTP limits. */
export interface WindowCapDecision {
  readonly limited: boolean;
  /** Whole seconds until the cap clears. 0 when not limited. */
  readonly retryAfterSeconds: number;
  /** Events inside the window, for logging. */
  readonly count: number;
}

/**
 * Drops everything at or before the window edge, then counts what is left.
 *
 * `>` rather than `>=` on the edge: an event exactly `windowMs` old is outside a
 * window that includes its own start, and counting it would hold a lockout open
 * for one extra tick past the boundary.
 *
 * Returns epoch milliseconds rather than `Date`s so the arithmetic below never
 * re-wraps a timestamp.
 */
function withinWindow(events: readonly AttemptEvent[], now: Date, windowMs: number): number[] {
  const cutoff = now.getTime() - windowMs;
  return events.map((event) => event.createdAt.getTime()).filter((at) => at > cutoff);
}

/**
 * A flat "at most `limit` events per `windowMs`" decision — the shape of the IP
 * cap (§6.3, 20 attempts/min) and of both OTP limits (≤3 sends / 15 min, ≤5
 * tries per token).
 *
 * `retryAfterSeconds` is the moment the count drops back below the limit, which
 * is when the `limit`-th newest event leaves the window — computed from real
 * timestamps rather than reported as the whole window, so a caller that retries
 * exactly when told is let back in immediately instead of being made to wait out
 * a full minute it has already served.
 */
export function evaluateWindowCap(
  events: readonly AttemptEvent[],
  now: Date,
  limit: number,
  windowMs: number,
): WindowCapDecision {
  const inside = withinWindow(events, now, windowMs).sort((a, b) => b - a);
  const count = inside.length;

  if (count < limit) {
    return { limited: false, retryAfterSeconds: 0, count };
  }

  // `inside` has at least `limit` entries here, and `noUncheckedIndexedAccess`
  // cannot see that, hence the explicit emptiness guard rather than `!`.
  const thresholdEvent = inside[limit - 1];
  if (thresholdEvent === undefined) {
    return { limited: false, retryAfterSeconds: 0, count };
  }

  const unlockAt = thresholdEvent + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((unlockAt - now.getTime()) / 1000));

  return { limited: true, retryAfterSeconds, count };
}

/** The policy knobs a lockout decision needs. */
export interface LockoutPolicy {
  /** §6.3: 5 consecutive failures. */
  readonly failuresPerWindow: number;
  /** §6.3: the first lockout, 15 minutes. */
  readonly baseWindowMs: number;
  /** §6.3: the escalation cap, 60 minutes. */
  readonly maxWindowMs: number;
}

export interface LockoutDecision extends WindowCapDecision {
  /** 0 at the base window, 1 after one escalation, 2 at the cap. */
  readonly level: number;
  /** The window this level locks for: base, doubled, capped. */
  readonly windowMs: number;
}

/**
 * §6.3's identity-key lockout, including the escalating window.
 *
 * **Why the level comes from the total run length and not from a stored counter.**
 * A lockout level has to be derivable from the rows that exist, because
 * `auth_attempts` is append-only and has no "lockout granted" column to hold it.
 * Level is therefore `floor(runLength / failuresPerWindow) - 1`, clamped at 0 by
 * construction: 5 failures → level 0, 10 → level 1, 15 → level 2, 20+ → still
 * level 2 because `min(base * 2^level, max)` saturates at the cap. That is what
 * produces §6.3's exact 15 → 30 → 60 ladder with no extra state, and it means a
 * process restart cannot lose or double-count a level.
 *
 * **Why the level and the window are separate.** The level decides how long the
 * lock lasts; the *window* decides which failures are counted toward it. A run of
 * 10 failures spread over an hour is at level 1 (a 30-minute lock if it recurs),
 * but is not locked right now, because fewer than 5 of them fall inside any
 * 30-minute window. That is the plain reading of "5 failures → 15-minute lockout"
 * and it is what stops a legitimate user who failed twice a week from being
 * locked out by a fortnight of typos.
 *
 * `failureTimes` must be an unbroken run: failures since the last SUCCESS on the
 * same key. The caller is responsible for that cut (see `readIdentityRun`), and it
 * matters — counting failures across a success would punish a user whose password
 * was mistyped, then corrected, then mistyped again.
 */
export function decideLockout(
  failureTimes: readonly AttemptEvent[],
  now: Date,
  policy: LockoutPolicy,
): LockoutDecision {
  const { failuresPerWindow, baseWindowMs, maxWindowMs } = policy;

  const doublings = Math.max(0, Math.ceil(Math.log2(maxWindowMs / baseWindowMs)));

  // Clamped to the ladder, not just made non-negative: `level` is a *position*
  // (0, 1, 2) and is what gets logged and returned to callers, so a 40-failure
  // run must report the top rung rather than "7". The cap is reached by
  // construction here rather than by the `min` on `windowMs` alone.
  const level = Math.min(Math.max(0, Math.floor(failureTimes.length / failuresPerWindow) - 1), doublings);
  const windowMs = Math.min(baseWindowMs * 2 ** level, maxWindowMs);

  const decision = evaluateWindowCap(failureTimes, now, failuresPerWindow, windowMs);

  return { ...decision, level, windowMs };
}

/**
 * How many failure rows are needed to decide, as a multiple of the threshold.
 *
 * Past the cap the ladder cannot grow, so fetching `failuresPerWindow` for the
 * base level plus one window per remaining doubling is sufficient — 15 rows at
 * the §6.3 defaults. Without this the query would read a user's whole failure
 * history on every login attempt, which is the most expensive possible query on
 * the hottest unauthenticated path.
 */
export function requiredFailureRows(policy: LockoutPolicy): number {
  const levels = Math.max(1, Math.ceil(Math.log2(policy.maxWindowMs / policy.baseWindowMs)) + 1);
  return policy.failuresPerWindow * levels;
}

// ---------------------------------------------------------------------------
// Policy read from config
// ---------------------------------------------------------------------------

/**
 * The policy as configured, with durations converted once.
 *
 * Reads `config` rather than taking arguments so a caller cannot invent a policy
 * for one call and bypass the operator's settings — but the *pure* functions
 * above take it as an argument, which is what lets the tests exercise a 5-minute
 * ladder without a matching environment.
 */
export function loginLockoutPolicy(): LockoutPolicy {
  return {
    failuresPerWindow: config.LOCKOUT_FAILURES,
    baseWindowMs: durationToMs(config.LOCKOUT_WINDOW),
    maxWindowMs: durationToMs(config.LOCKOUT_MAX_WINDOW),
  };
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

/**
 * The unbroken failure run for an identity key: every failure since that key's
 * most recent success.
 *
 * Two queries rather than one because "consecutive" is not expressible as a
 * filter — the cut-off point is itself the answer to a query. The index
 * `(identifier_key, purpose, created_at)` (`schema.prisma:1050`) serves both: the
 * success lookup is a descending scan of one key's rows, and the failure lookup
 * is the same scan with `succeeded = false` applied.
 *
 * Successes are recorded for exactly this reason. Storing them makes "consecutive"
 * computable; a table that only held failures could not tell a five-minute typo
 * streak from five failures spread over a month.
 */
async function readIdentityRun(
  identifierKey: string,
  purpose: AuthAttemptPurpose,
  take: number,
): Promise<AttemptEvent[]> {
  const lastSuccess = await prisma.authAttempt.findFirst({
    where: { identifierKey, purpose, succeeded: true },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return prisma.authAttempt.findMany({
    where: {
      identifierKey,
      purpose,
      succeeded: false,
      // No success on record is not "no lower bound" spelled differently: it is
      // an unbounded run, and the epoch makes the one query cover both cases.
      createdAt: { gt: lastSuccess?.createdAt ?? new Date(0) },
    },
    orderBy: { createdAt: "desc" },
    take,
    select: { createdAt: true },
  });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordAttemptInput {
  /** The normalised email, or the token hash for an OTP purpose. */
  readonly identifierKey: string;
  readonly ipKey: string;
  readonly purpose: AuthAttemptPurpose;
  readonly succeeded: boolean;
}

/**
 * Appends one attempt. Append-only: there is no update path, and the count is
 * derived by reading rows rather than by incrementing a number.
 *
 * Both outcomes are recorded, not just failures. A success is what breaks a run,
 * so a table holding only failures could not implement "consecutive" at all.
 */
export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  await prisma.authAttempt.create({
    data: {
      identifierKey: input.identifierKey,
      ipKey: input.ipKey,
      purpose: input.purpose,
      succeeded: input.succeeded,
    },
  });
}

/**
 * Records a failure without letting a logging failure mask the real error.
 *
 * `succeeded` is not a parameter: a caller reaching for this has already decided
 * the attempt failed, and letting it pass `succeeded: true` would quietly break the
 * "a success breaks the run" rule that `readIdentityRun` depends on.
 */
export async function recordFailureQuietly(input: Omit<RecordAttemptInput, "succeeded">): Promise<void> {
  try {
    await recordAttempt({ ...input, succeeded: false });
  } catch {
    // Deliberately swallowed. Every caller is already failing with a 401 or a
    // 429, and replacing that with a 500 because the *attempt log* could not be
    // written turns a rate limiter into an availability dependency: the database
    // is then required for the app to reject a bad password, and a stopped
    // database would read as "login is broken" rather than "logging is broken".
    // The cost is a lost row, which weakens the lockout by one failure.
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * §6.3's IP key, shared by all three gates.
 *
 * One helper rather than three near-copies, because the three gates differ only in
 * `purpose` and the copy is where the arguments drift apart — the login gate's IP
 * term once ended up documented as the *only* thing standing between a botnet and a
 * password-spray, while the OTP gates carried none at all.
 *
 * `limit` and `windowMs` default to the §6.3 IP numbers because §6.3 states one IP
 * cap for the policy ("20 attempts/min/IP"), keyed per purpose so a login flood and
 * an OTP flood spend separate budgets. Both defaults are overridable for the case
 * where a purpose needs a tighter ceiling than login does.
 */
async function assertIpWindowAllowed(
  ipKey: string,
  purpose: AuthAttemptPurpose,
  now: Date,
  limit: number = config.IP_ATTEMPTS_PER_WINDOW,
  windowMs: number = durationToMs(config.IP_WINDOW),
): Promise<void> {
  const recent = await prisma.authAttempt.findMany({
    where: { ipKey, purpose, createdAt: { gt: new Date(now.getTime() - windowMs) } },
    orderBy: { createdAt: "desc" },
    // `limit` rows is exactly enough to decide: at the limit the cap is hit, and
    // one short of it the cap is not.
    take: limit,
    select: { createdAt: true },
  });

  const cap = evaluateWindowCap(recent, now, limit, windowMs);
  if (cap.limited) {
    throw rateLimitedError(cap.retryAfterSeconds);
  }
}

/**
 * The §6.3 gate for an unauthenticated credential attempt.
 *
 * Called BEFORE the bcrypt comparison, not after: the point of the identity cap
 * is to stop an attacker spending a hundred milliseconds of CPU per guess, and a
 * check that runs after the hash has already paid that cost once per attempt.
 *
 * Identity first, then IP. The order only affects which message would be logged,
 * since both refusals are identical to the caller.
 */
export async function assertLoginAttemptAllowed(
  identifierKey: string,
  ipKey: string,
  now: Date = new Date(),
): Promise<void> {
  const policy = loginLockoutPolicy();

  const identityRun = await readIdentityRun(
    identifierKey,
    $Enums.AuthAttemptPurpose.LOGIN,
    requiredFailureRows(policy),
  );

  const lockout = decideLockout(identityRun, now, policy);
  if (lockout.limited) {
    throw rateLimitedError(lockout.retryAfterSeconds);
  }

  await assertIpWindowAllowed(ipKey, $Enums.AuthAttemptPurpose.LOGIN, now);
}

/**
 * §6.3's OTP email-bombing cap: at most `OTP_SEND_LIMIT` sends per
 * `OTP_SEND_WINDOW` for one address.
 *
 * Two keys, because §6.3 gives the IP key this exact job ("guarding against ...
 * OTP email-bombing") and an address-only cap cannot deliver it. A botnet sending
 * three mails per address walks straight through a per-address limit while costing
 * a real inbox provider a reputation hit.
 *
 * Exported and unused on purpose: Day 11's forgot-password is the first thing that
 * sends an OTP, and having the limit already written and reviewed means the first
 * caller wires it up rather than reinventing it. The IP term matters most here,
 * since sending is the expensive direction.
 */
export async function assertOtpSendAllowed(
  identifierKey: string,
  ipKey: string,
  now: Date = new Date(),
): Promise<void> {
  const windowMs = durationToMs(config.OTP_SEND_WINDOW);

  const recent = await prisma.authAttempt.findMany({
    where: {
      identifierKey,
      purpose: $Enums.AuthAttemptPurpose.OTP_SEND,
      createdAt: { gt: new Date(now.getTime() - windowMs) },
    },
    orderBy: { createdAt: "desc" },
    take: config.OTP_SEND_LIMIT,
    select: { createdAt: true },
  });

  const cap = evaluateWindowCap(recent, now, config.OTP_SEND_LIMIT, windowMs);
  if (cap.limited) {
    throw rateLimitedError(cap.retryAfterSeconds);
  }

  await assertIpWindowAllowed(ipKey, $Enums.AuthAttemptPurpose.OTP_SEND, now);
}

/**
 * §6.3's "≤5 verification tries per OTP".
 *
 * **Two caps, and the second one is the one that does the work.**
 *
 * The per-OTP cap is keyed on `hash(submittedToken)`, and on its own it is close to
 * inert against the threat §6.3 names. Brute force works by submitting *different*
 * codes, and each different code hashes differently — so every guess arrives under a
 * fresh key with a full budget of five. Thirty wrong codes against one issued token
 * produced thirty 400s and no 429, which is the same as no limit at all. What the
 * per-OTP cap genuinely protects is the *valid* token: five looks total, of which
 * the one legitimate submission is one, so a leaked token cannot be ground down by
 * resubmitting it.
 *
 * The IP term is what bounds guessing, and it is the reason this function takes an
 * `ipKey` at all. §6.3 lists the IP key as the secondary cap for exactly this class
 * of abuse, and a guess flood is inherently single-sourced: brute forcing one token
 * means coming from one host. Twenty guesses a minute against a six-digit space is
 * ~29k/day, which cannot exhaust 10^6 before the token expires.
 *
 * The scope worry — one locked host spending every unrelated patient's budget — does
 * not apply, because the budget is 20/min *shared across all verification traffic
 * from that host*, not 20/min per patient. Legitimate verification volume is a
 * handful of requests, so the shared ceiling is far above real use while still
 * bounding an attacker. A tighter per-patient ceiling is not expressible here at
 * all: `/verify-email` carries only the submitted code, so a *wrong* guess cannot be
 * attributed to any issued token, and therefore not to any patient. That is a
 * property of the endpoint contract, and the honest fix is to carry the address in
 * the verification link — noted here rather than changed now, since it moves the
 * Day 7 link format and the client with it.
 *
 * Ordering: per-OTP first, because it is one indexed read on `identifier_key` and
 * settles the common "replay the same code" case without touching the IP query.
 */
export async function assertOtpVerifyAllowed(tokenHash: string, ipKey: string): Promise<void> {
  const attempts = await prisma.authAttempt.findMany({
    where: { identifierKey: tokenHash, purpose: $Enums.AuthAttemptPurpose.OTP_VERIFY },
    orderBy: { createdAt: "desc" },
    // `OTP_VERIFY_LIMIT` is a TOTAL cap, not a sliding window, so the read is
    // unbounded in time and bounded in rows. Five rows is also the whole decision.
    take: config.OTP_VERIFY_LIMIT,
    select: { id: true },
  });

  if (attempts.length >= config.OTP_VERIFY_LIMIT) {
    // No window, so the honest wait is the token's remaining lifetime — the budget
    // is spent for as long as the token lives. `auth_tokens` is in this same
    // database, so the expiry is one extra column on a row the caller has already
    // fetched; reporting it turns an un-actionable 429 into one a client can wait
    // out. An already-expired token reports 1 second rather than 0, because 0 means
    // "no honest wait" and the handler omits the header for it.
    const token = await prisma.authToken.findUnique({
      where: { tokenHash },
      select: { expiresAt: true },
    });

    const retryAfterSeconds = token
      ? Math.max(1, Math.ceil((token.expiresAt.getTime() - Date.now()) / 1000))
      : 1;

    throw rateLimitedError(retryAfterSeconds);
  }

  await assertIpWindowAllowed(ipKey, $Enums.AuthAttemptPurpose.OTP_VERIFY, new Date());
}
