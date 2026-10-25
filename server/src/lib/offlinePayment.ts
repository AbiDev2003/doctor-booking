import { AppError } from "./appError.js";

/**
 * Day 26 — the one arithmetic rule of pay-at-clinic collection.
 *
 * The desk may collect the full outstanding fee or LESS (a deliberate
 * concession); it may never collect more than the booking owes. Paise are
 * integers, so the same wall rejects fractions and non-positive amounts even if
 * a future caller bypasses the request schema.
 */
export function resolveCollectedAmount(outstandingPaise: number, requestedPaise?: number | undefined): number {
  if (requestedPaise === undefined) return outstandingPaise;
  if (!Number.isInteger(requestedPaise) || requestedPaise <= 0) {
    throw new AppError(422, "INVALID_AMOUNT", "The collected amount must be a positive whole number of paise.");
  }
  if (requestedPaise > outstandingPaise) {
    throw new AppError(
      422,
      "AMOUNT_EXCEEDS_FEE",
      `The collected amount cannot exceed the outstanding ${outstandingPaise} paise.`,
    );
  }
  return requestedPaise;
}
