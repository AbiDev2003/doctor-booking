import { AppError } from "./appError.js";

/**
 * The single local-time conversion module (plan.md §3.2, code-plan.md Day 5).
 *
 * Three jobs, and nothing else in the codebase is allowed to do any of them:
 *   1. build the `startAt` / `endAt` UTC instants from a clinic-local wall clock
 *   2. format a UTC instant into clinic-local time for display
 *   3. normalise a phone number to E.164
 *
 * Why this is one module rather than scattered `Date` arithmetic: `slots` stores
 * the same window twice, as a clinic-local wall clock (`slot_date` + `start_time`
 * — what staff typed) and as UTC instants (`start_at` + `end_at` — what every
 * comparison reads). The instants are written ONCE, here, and never recomputed.
 *
 * Two deliberate design choices, both of which look like needless strictness:
 *
 * `timeZone` is a REQUIRED argument and has no default. There are two timezone
 * values in this codebase — the `APP_TIMEZONE` env var and the `Clinic.timezone`
 * config row — and silently defaulting to one of them is precisely how a slot
 * gets written in one zone and displayed in another. Making the caller name the
 * zone forces the one decision that has to be made explicitly, and it keeps this
 * function testable without an environment.
 *
 * The DST rules below are unreachable for `Asia/Kolkata`, which has had no DST
 * since 1945. They are implemented anyway because the timezone is configuration:
 * a clinic that moves, or a staging box pointed at `America/New_York`, would
 * otherwise get the silent one-hour shift §3.2 calls out as surfacing weeks
 * later as "the appointment was at the wrong time".
 */

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * India's country calling code, as the default for national-format phone input.
 *
 * Named and exported rather than inlined at each call site, because it is
 * configuration-shaped (§3.2: no magic constants). `normalizePhoneToE164`
 * still accepts an override for the case that ever needs it.
 */
export const DEFAULT_COUNTRY_CALLING_CODE = "91";

/** A clinic-local wall clock: the `date` and `time` columns, as strings. */
export interface LocalDateTime {
  /** `YYYY-MM-DD` — matches `slots.slot_date`. */
  readonly date: string;
  /** `HH:mm` or `HH:mm:ss` — matches `schedules.start_time` / `slots.end_time`. */
  readonly time: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * `Intl.DateTimeFormat` construction is expensive enough to matter when a slot
 * generator calls this in a loop, and the set of zones is tiny and bounded.
 */
function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
  } catch {
    // An invalid zone surfaces as a RangeError from the constructor. Left
    // uncaught it would be an opaque failure at the first booking attempt
    // rather than a named config error.
    throw new AppError(
      500,
      "INVALID_TIMEZONE",
      `APP_TIMEZONE/Clinic.timezone is not a valid IANA time zone: "${timeZone}"`,
    );
  }

  formatterCache.set(timeZone, formatter);
  return formatter;
}

// Dead — no caller. Commented out rather than deleted (Day 5 review). It is a
// wrapper around the internal getFormatter, which ALREADY throws
// INVALID_TIMEZONE on a bad zone, so this export adds nothing the module does
// not already do on every call. Uncomment only if a caller needs to validate a
// zone without converting anything.
//
// /** Throws unless `timeZone` is an IANA zone this runtime understands. */
// export function assertValidTimeZone(timeZone: string): void {
//   getFormatter(timeZone);
// }

/**
 * The zone's UTC offset, in milliseconds, at the given instant.
 *
 * Derived by formatting the instant into the zone and re-reading the result as
 * if it were UTC: the difference between the two is the offset. Positive east of
 * Greenwich, so `wallClockAsUTC - offset` yields the correct instant.
 */
function getOffsetMs(instant: Date, timeZone: string): number {
  const parts = getFormatter(timeZone).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new AppError(500, "TIMEZONE_FORMAT_FAILED", `Intl omitted "${type}" for zone "${timeZone}"`);
    }
    return Number(part.value);
  };

  const year = read("year");
  // BC dates arrive as a positive year plus era "BC", which Date.UTC cannot
  // express. A clinic wall clock before 1 AD is not a real case, and silently
  // returning year 1 is worse than refusing it.
  const era = parts.find((candidate) => candidate.type === "era");
  if (era !== undefined && era.value === "BC") {
    throw new AppError(500, "UNSUPPORTED_DATE", "Dates before 1 AD are not supported");
  }

  const asUtc = Date.UTC(year, read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));

  return asUtc - instant.getTime();
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month IS the last day of this one, so this needs no leap-year special case.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validates and splits a wall clock into its numeric parts.
 *
 * Range checks are explicit because `Date.UTC` silently rolls over: `month: 13`
 * becomes January of the next year, and `2026-02-30` becomes 2 March. A slot that
 * quietly moves date is the same class of bug as one that quietly moves hour.
 */
function parseLocalDateTime(local: LocalDateTime, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dateMatch = DATE_PATTERN.exec(local.date);
  if (dateMatch === null) {
    throw new AppError(400, "INVALID_LOCAL_DATE", `"${local.date}" is not a YYYY-MM-DD date`);
  }

  const timeMatch = TIME_PATTERN.exec(local.time);
  if (timeMatch === null) {
    throw new AppError(400, "INVALID_LOCAL_TIME", `"${local.time}" is not an HH:mm or HH:mm:ss time`);
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);

  if (month < 1 || month > 12) {
    throw new AppError(400, "INVALID_LOCAL_DATE", `Month ${month} is out of range`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new AppError(400, "INVALID_LOCAL_DATE", `Day ${day} is out of range for ${local.date}`);
  }
  // A leap second (:60) is rejected rather than clamped. This clinic's slots are
  // minute-granular, and accepting a value the database cannot store would move
  // the error somewhere less obvious.
  if (hour > 23 || minute > 59 || second > 59) {
    throw new AppError(400, "INVALID_LOCAL_TIME", `"${local.time}" is out of range`);
  }

  // Validates the zone even when the wall clock is unambiguous, so a typo'd
  // timezone fails at the boundary rather than on the first DST edge.
  getFormatter(timeZone);

  return { year, month, day, hour, minute, second };
}

/**
 * Every UTC offset that could apply to this wall clock.
 *
 * A zone has at most one offset in effect at any instant, and offsets change
 * only at transitions (at most a couple per year). Sampling the requested wall
 * clock plus ±1 day and ±180 days therefore covers every distinct offset that
 * could be valid for it, which is what makes the gap and overlap detection below
 * exhaustive rather than a single-guess heuristic.
 */
function collectCandidateOffsets(wallClockAsUtc: number, timeZone: string): number[] {
  const offsets = new Set<number>();

  for (const shift of [0, -MILLISECONDS_PER_DAY, MILLISECONDS_PER_DAY, -180 * MILLISECONDS_PER_DAY, 180 * MILLISECONDS_PER_DAY]) {
    offsets.add(getOffsetMs(new Date(wallClockAsUtc + shift), timeZone));
  }

  return [...offsets];
}

/**
 * Converts a clinic-local wall clock to the UTC instant it denotes.
 *
 * Rejects a wall clock that does not exist (the spring-forward gap) and, for one
 * that occurs twice (the fall-back hour), returns the FIRST occurrence — the one
 * before the clocks go back, which is the earlier instant and therefore the
 * conservative choice for "when does this slot end".
 *
 * The algorithm is round-trip verification rather than offset arithmetic: for
 * every offset the zone could plausibly be using, subtract it, then format the
 * result back into the zone and check it reproduces the requested wall clock
 * exactly. Zero matches means the wall clock is in a gap; two means it is
 * ambiguous; one means it is ordinary.
 */
export function localDateTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const { year, month, day, hour, minute, second } = parseLocalDateTime(local, timeZone);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const matches = collectCandidateOffsets(wallClockAsUtc, timeZone)
    .map((offset) => new Date(wallClockAsUtc - offset))
    .filter((candidate) => formatsBackTo(candidate, wallClockAsUtc, timeZone));

  if (matches.length === 0) {
    // Slot generation catches this, logs it, and skips the window rather than creating it (§3.2).
    throw new AppError(
      422,
      "NONEXISTENT_LOCAL_TIME",
      `${local.date} ${local.time} does not exist in "${timeZone}" — the clocks skip forward over it`,
      { local, timeZone },
    );
  }

  // Earliest instant wins the fall-back hour. `Math.min` over timestamps, not
  // over the Date objects.
  return new Date(Math.min(...matches.map((candidate) => candidate.getTime())));
}

/**
 * True when rendering `instant` in `timeZone` reproduces `wallClockAsUtc`.
 *
 * `getOffsetMs` is `renderedAsUTC - instant`, so the wall clock is reproduced
 * exactly when `renderedAsUTC === wallClockAsUtc`, i.e. when the offset equals
 * `wallClockAsUtc - instant`. That is the offset the candidate was built by
 * subtracting, so the test is really "the guess was self-consistent".
 */
function formatsBackTo(instant: Date, wallClockAsUtc: number, timeZone: string): boolean {
  return getOffsetMs(instant, timeZone) === wallClockAsUtc - instant.getTime();
}

/**
 * The clinic-local wall clock an instant falls on. The inverse of
 * `localDateTimeToUtc`, and the read path for display.
 */
export function utcToLocalDateTime(instant: Date, timeZone: string): LocalDateTime {
  getFormatter(timeZone);

  const parts = getFormatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new AppError(500, "TIMEZONE_FORMAT_FAILED", `Intl omitted "${type}" for zone "${timeZone}"`);
    }
    return part.value;
  };

  const hour = read("hour") === "24" ? "00" : read("hour");

  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    time: `${hour}:${read("minute")}:${read("second")}`,
  };
}

/** `YYYY-MM-DD HH:mm:ss` in clinic-local time — for logs, emails and CLI output. */
export function formatInClinicTime(instant: Date, timeZone: string): string {
  const local = utcToLocalDateTime(instant, timeZone);
  return `${local.date} ${local.time}`;
}

/**
 * The UTC instants bounding a clinic-local calendar day.
 *
 * "Today" is a property of the clinic's timezone, never of the server's — a
 * host running UTC is 5.5 hours behind `Asia/Kolkata`, so `new Date()` alone
 * would split a clinic day in two. Day 14's doctor queue window and Phase 4's
 * slot materialisation both query by these bounds.
 *
 * The day is computed from the instant's own clinic-local date, then the next
 * clinic-local date is the `Date.UTC(year, month, day + 1)` one-calendar-day
 * shift formatted back into the zone — `Date.UTC` is pure proleptic-calendar
 * arithmetic, so the shift is deterministic even across a DST transition and a
 * year boundary, and `localDateTimeToUtc` answers for whatever zone is asked.
 * The end bound is exclusive, matching every other `gte`/`lt` window in this
 * codebase.
 */
export function clinicDayRange(
  instant: Date,
  timeZone: string,
): { readonly start: Date; readonly endExclusive: Date } {
  const date = utcToLocalDateTime(instant, timeZone).date;
  // Slicing a fixed-length `YYYY-MM-DD` string (rather than `split().map(Number)`)
  // keeps the parts `number` under `noUncheckedIndexedAccess`: `Number("2026")`
  // is always a number, while an array element is `number | undefined`.
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1; // Date.UTC's 0-based month
  const day = Number(date.slice(8, 10));
  const tomorrow = new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);

  return {
    start: localDateTimeToUtc({ date, time: "00:00:00" }, timeZone),
    endExclusive: localDateTimeToUtc({ date: tomorrow, time: "00:00:00" }, timeZone),
  };
}

const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * Normalises a phone number to E.164 (`+<country><subscriber>`).
 *
 * The same call is used at patient registration, at the desk for
 * create-or-find-by-phone, and on a phone change (§6.1, §16), so one person can
 * never end up as two rows under two spellings of the same number.
 *
 * Accepted inputs: `+919876543210`, `00919876543210`, `09876543210`,
 * `9876543210`, `+91 98765 43210`, `(98765) 43210`. Separators are stripped
 * rather than rejected, because they are how humans write numbers and this value
 * arrives from a form.
 *
 * Only a leading `+` or `00` marks an international number. A bare `91-98765-43210`
 * is therefore treated as NATIONAL and normalises to `+91919876543210`, not to
 * `+919876543210`. That is deliberate: the input is genuinely ambiguous, and
 * guessing which reading was meant is how one person becomes two rows under two
 * spellings of the same number. Callers that genuinely know the value is already
 * international should pass it through `+`/`00` form.
 *
 * @param raw                  the number as entered
 * @param defaultCallingCode   country code for national-format input
 */
export function normalizePhoneToE164(
  raw: string,
  defaultCallingCode: string = DEFAULT_COUNTRY_CALLING_CODE,
): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new AppError(400, "INVALID_PHONE", "Phone number is empty");
  }

  // Strip the punctuation people actually type. Digits, a leading `+`, and `*`
  // / `#` (used for extensions) are all that remain meaningful.
  const stripped = trimmed.replace(/[\s\-().]/g, "");
  if (stripped === "") {
    throw new AppError(400, "INVALID_PHONE", "Phone number contains no digits");
  }

  let digits: string;

  if (stripped.startsWith("+")) {
    digits = stripped.slice(1);
  } else if (/^00\d/.test(stripped)) {
    // 00 is the international access prefix; it maps onto the same `+` form.
    digits = stripped.slice(2);
  } else {
    const code = defaultCallingCode.replace(/\D/g, "");
    if (code === "") {
      throw new AppError(500, "INVALID_COUNTRY_CODE", "Country calling code must contain digits");
    }

    // A leading national trunk `0` is dropped before the country code is added;
    // 09876543210 and 9876543210 are the same number.
    const national = stripped.replace(/^0+/, "");
    digits = `${code}${national}`;
  }

  if (!/^\d+$/.test(digits)) {
    throw new AppError(400, "INVALID_PHONE", `"${raw}" contains characters that are not digits`);
  }

  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    // E.164 caps at 15 digits. The lower bound is a floor, not a claim that every
    // country's shortest number is 8 — it exists so a mistyped short string does
    // not become a valid-looking identity key.
    throw new AppError(
      400,
      "INVALID_PHONE",
      `"${raw}" is not a valid E.164 number: expected ${MIN_E164_DIGITS}-${MAX_E164_DIGITS} digits, got ${digits.length}`,
    );
  }

  return `+${digits}`;
}

// Dead — no caller, and not required by §3.2. The "exists so it reads
// explicitly" rationale was me talking myself into keeping it; comparing two
// Dates needs no helper. Commented out rather than deleted (Day 5 review).
//
// /** True when `end` is after `start`. */
// export function isAfter(end: Date, start: Date): boolean {
//   return end.getTime() > start.getTime();
// }

