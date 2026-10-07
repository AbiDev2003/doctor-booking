import { AppError } from "./appError.js";

/**
 * Duration strings ("30s", "15m", "2h", "7d") to milliseconds.
 *
 * Lives in `lib/` rather than in `config.ts` because two very different layers
 * need it and neither should own it: the config schema validates the *shape*
 * of an operator-supplied duration, and the rate limiter has to *compute* with
 * one. A second copy of this regex in the service is the kind of divergence that
 * lets `LOCKOUT_WINDOW=15x` boot cleanly and then silently mean something else.
 *
 * It is deliberately NOT in `lib/time.ts`: that module's own contract is three
 * named jobs involving clinic wall clocks, and this is neither of them.
 */

export const DURATION_PATTERN = /^\d+[smhd]$/;

const MS_PER_UNIT = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type DurationUnit = keyof typeof MS_PER_UNIT;

/**
 * Throws `AppError` on anything the pattern does not accept.
 *
 * Every caller validates first — the config schema applies `DURATION_PATTERN`
 * before this is ever reached — so a throw here is a programming error rather
 * than bad input, and it is reported as a 500 for that reason. Callers that run
 * during validation must guard it (see the `LOCKOUT_MAX_WINDOW` refine in
 * `config.ts`), because throwing out of a Zod refine replaces a precise field
 * error with an opaque crash.
 */
export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);

  if (match === null) {
    throw new AppError(500, "INVALID_DURATION", `"${value}" is not a duration like 30s, 15m, 2h or 7d`);
  }

  const amount = Number(match[1]);
  const unit = match[2] as DurationUnit;

  // A duration of 0 is representable by the pattern ("0m") and meaningless as a
  // window — a zero-length window counts nothing and never locks anyone. The
  // config schema rejects it; this is the second line of defence for a value
  // that reaches here from code rather than from the environment.
  const ms = amount * MS_PER_UNIT[unit];

  if (ms <= 0) {
    throw new AppError(500, "INVALID_DURATION", `"${value}" must be a positive duration`);
  }

  return ms;
}
