/**
 * plan.md §11 — the pure predicate that decides whether a dated Slot is
 * BOOKABLE, Day 17.
 *
 * This is the read model's judgment call, split from the I/O for the same
 * reason `doctorState.ts` and `slotGuard.ts` are: the answer is a property of
 * inputs the caller has already fetched (a slot row, the clinic's tunables,
 * the doctor's unavailabilities, an instant), so it is unit-testable without a
 * database while the DB-backed harness still belongs to a later day.
 *
 * **Advisory, not authoritative.** This decides what the anonymous storefront
 * *shows*. Day 19's booking transaction re-checks every one of these
 * conditions inside its own transaction against live rows (§5.2's race guard),
 * because a listing can be a few milliseconds stale without being wrong — but
 * it must never show a slot that is *obviously* unbookable. Two deliberate
 * choices fall out of that:
 *
 * - **Fullness reads the stored counters** (`bookedCount + heldCount >=
 *   maxPatients`, §8.1), not a live row-count. A stale counter that is too
 *   HIGH only hides a slot that might have been free — the safe direction. A
 *   stale counter that is too LOW cannot occur, because released holds lower
 *   `heldCount` (schema.prisma:494), so the read model can under-show, never
 *   over-show. The authoritative re-count is Day 19's job.
 * - **The doctor filter is the same §5 rule** (`isBookable`) the public list
 *   uses, applied by the service through `bookableFilter`. One definition,
 *   so listing and booking cannot disagree about who is bookable.
 *
 * The five hides, in the order `isSlotBookable` applies them, all from the
 * Day 17 spec: disabled slots (§8.4), full slots (§8.1), slots already started
 * or inside the lead-time window (§8.5), dates outside the booking horizon
 * (§10), and slots overlapping a `DoctorUnavailability` (§11/§12). Time-zone
 * discipline (§3.2): every instant comparison reads the UTC `startAt`/`endAt`,
 * never a wall clock; the horizon compares clinic-local `YYYY-MM-DD` strings,
 * which sort chronologically because they are zero-padded.
 */

/** A half-open instant window `[startAt, endAt)` — a slot or a disruption. */
export interface InstantWindow {
  readonly startAt: Date;
  readonly endAt: Date;
}

/** A slot's §8.1 capacity counters, the only fields fullness reads. */
export interface SlotCapacity {
  readonly maxPatients: number;
  readonly bookedCount: number;
  readonly heldCount: number;
}

/** A slot reduced to what bookability judges. */
export interface BookabilitySlot extends InstantWindow, SlotCapacity {
  /** Clinic-local calendar date (`YYYY-MM-DD`); compared to the horizon as a string. */
  readonly slotDate: string;
  /** §8.4's disable flag — a disabled slot is never offered. */
  readonly isDisabled: boolean;
}

/** The clinic-local date range a booking may fall in, inclusive at both ends. */
export interface BookingHorizon {
  readonly earliestDate: string;
  readonly latestDate: string;
}

/** Everything outside the slot that bookability needs, injected for testability. */
export interface BookabilityContext {
  readonly now: Date;
  /** §8.5's lead time: a slot is closed once `startAt <= now + minLeadMinutes`. */
  readonly minLeadMinutes: number;
  readonly horizon: BookingHorizon;
  /** §11/§12 disruptions overlapping the slot's day; only the window fields are read. */
  readonly unavailabilities: readonly InstantWindow[];
}

/**
 * True when two half-open windows overlap. Touching edges do NOT overlap: a
 * slot ending at 10:00 and a disruption starting at 10:00 can coexist, which
 * is the whole point of storing `[start, end)` — the same convention every
 * other window comparison in this codebase uses.
 */
export function instantsOverlap(a: InstantWindow, b: InstantWindow): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

/** True when `slotDate` is inside `[earliestDate, latestDate]` (§10). */
export function isWithinHorizon(slotDate: string, horizon: BookingHorizon): boolean {
  return slotDate >= horizon.earliestDate && slotDate <= horizon.latestDate;
}

/**
 * True when the slot can no longer be booked because its start is at or before
 * `now + minLeadMinutes` (§8.5). At the boundary the slot is already closed:
 * "bookable until exactly the window opens" means at the instant it opens it
 * is gone.
 */
export function hasStarted(slot: InstantWindow, now: Date, minLeadMinutes: number): boolean {
  return slot.startAt.getTime() <= now.getTime() + minLeadMinutes * 60_000;
}

/**
 * True when every seat is claimed (§8.1). A hold counts as a claimed seat —
 * `heldCount` is a lower bound on true occupancy (schema.prisma:494), so
 * treating it as booked is the conservative, safe reading.
 */
export function isFull(slot: SlotCapacity): boolean {
  return slot.bookedCount + slot.heldCount >= slot.maxPatients;
}

/** True when any §11/§12 disruption overlaps the slot's window. */
export function overlapsUnavailability(slot: InstantWindow, unavailabilities: readonly InstantWindow[]): boolean {
  return unavailabilities.some((window) => instantsOverlap(slot, window));
}

/**
 * Seats a patient could still take, floored at zero. A UX hint only: it reads
 * the same stored counters as `isFull`, so it carries the same unswept-hold
 * staleness (never below the true free count).
 */
export function remainingSeats(slot: SlotCapacity): number {
  return Math.max(0, slot.maxPatients - slot.bookedCount - slot.heldCount);
}

/**
 * The one question the storefront asks: may this slot be shown as bookable?
 * Every hide is an AND condition, so the order is immaterial — the named
 * helpers exist so the single-line composition stays readable and each rule
 * gets its own test.
 */
export function isSlotBookable(slot: BookabilitySlot, context: BookabilityContext): boolean {
  return (
    !slot.isDisabled &&
    !isFull(slot) &&
    !hasStarted(slot, context.now, context.minLeadMinutes) &&
    isWithinHorizon(slot.slotDate, context.horizon) &&
    !overlapsUnavailability(slot, context.unavailabilities)
  );
}
