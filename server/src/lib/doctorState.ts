import { $Enums } from "../generated/prisma/client.js";
import { AppError } from "./appError.js";

/**
 * plan.md §5's doctor state machine — the Day 12 DoD ("the §5 transition
 * matrix is enforced; role limits hold") lives entirely in this file.
 *
 * Pure by design: no database, no request, no Prisma row — just the judgment
 * "may THIS actor perform THIS action on a doctor in THIS state". That is what
 * makes the whole matrix unit-testable on Day 12, when the DB-backed harness
 * does not exist yet (it arrives Day 35), and it is the same posture Day 9's
 * `decideLockout` and Day 10's gates took.
 *
 * Two independent dimensions, exactly as the schema models them:
 *
 * 1. **Role limits** (§5.2): verification decisions — VERIFY, REJECT — and the
 *    two restorations — UNSUSPEND, UNARCHIVE — are ADMIN-only. SUSPEND and
 *    ARCHIVE are STAFF or ADMIN. Profile edits add DOCTOR (self), which the
 *    route layer has already proven is `self` via `requireSelfOrRole` before
 *    this function ever sees the action: a DOCTOR actor here is always the
 *    doctor being edited. PATIENT is never a legal actor for any action.
 *
 * 2. **Status legality** (§5): ARCHIVED is terminal except for UNARCHIVE;
 *    REJECTED is terminal outright (§5: "a new invite is required") — so a
 *    profile edit cannot resurrect a rejected doctor, which is the loophole a
 *    single combined enum could not have closed. Suspension is deliberately
 *    absent from most rules: it is orthogonal (§5), so a suspended doctor may
 *    still be edited or verified, and only SUSPEND/UNSUSPEND touch it.
 *
 * Every refusal is an `AppError` with a specific `code` (403 for a role the
 * caller does not hold, 409 for a state the target is not in) so a legitimate
 * client can branch without parsing prose — while the role messages stay
 * generic, in the same spirit as §6.3's 429s: an endpoint-probing caller must
 * not learn which role it almost had.
 *
 * First real callers: `services/doctor.service.ts` (Day 12). Booking-side
 * visibility ("bookable" below) is consumed by Day 13's public doctor list and
 * Phase 4's slot engine.
 */

export type DoctorAction =
  | "EDIT_PROFILE" // descriptive fields only — status must not move (§5.2)
  | "EDIT_CREDENTIALS" // any verification-impacting field changed (§5.2)
  | "VERIFY"
  | "REJECT"
  | "SUSPEND"
  | "UNSUSPEND"
  | "ARCHIVE"
  | "UNARCHIVE";

export interface DoctorState {
  readonly verificationStatus: $Enums.DoctorVerificationStatus;
  readonly suspendedAt: Date | null;
}

/** The acting user, reduced to the one thing this file judges: the role. */
export interface Actor {
  readonly role: $Enums.UserRole;
}

const S = $Enums.DoctorVerificationStatus;
const R = $Enums.UserRole;

/** ADMIN-only actions: verification decisions and both restorations (§5.2). */
const ADMIN_ONLY: readonly DoctorAction[] = ["VERIFY", "REJECT", "UNSUSPEND", "UNARCHIVE"];

/** STAFF-or-ADMIN actions: the off-boarding half of §5.2. */
const STAFF_OR_ADMIN: readonly DoctorAction[] = ["SUSPEND", "ARCHIVE"];

/** Profile edits are the one place DOCTOR acts — always on itself. */
const EDIT_ACTIONS: readonly DoctorAction[] = ["EDIT_PROFILE", "EDIT_CREDENTIALS"];

function forbidden(): AppError {
  // One message for every role refusal, for the reason documented at the top:
  // the code stays specific (FORBIDDEN) so a legitimate client can react, the
  // prose reveals nothing about which roles exist.
  return new AppError(403, "FORBIDDEN", "You do not have access to this resource");
}

function invalidTransition(current: $Enums.DoctorVerificationStatus, action: DoctorAction): AppError {
  return new AppError(
    409,
    "INVALID_STATE_TRANSITION",
    `${action} is not allowed for a doctor with status ${current}`,
  );
}

/**
 * Throws unless `actor` may perform `action` on a doctor in `state`.
 * Returns nothing: this file decides legality, the service applies the result
 * (the resulting status is a property of the action, computed there next to
 * the conditional update that enforces it under race).
 */
export function assertDoctorAction(state: DoctorState, action: DoctorAction, actor: Actor): void {
  /* ---- 1. Role gate, before any state is revealed (403 over 409). ---- */

  if (actor.role === R.PATIENT) {
    throw forbidden();
  }

  if (EDIT_ACTIONS.includes(action)) {
    if (actor.role !== R.DOCTOR && actor.role !== R.STAFF && actor.role !== R.ADMIN) {
      throw forbidden();
    }
  } else if (ADMIN_ONLY.includes(action)) {
    if (actor.role !== R.ADMIN) {
      throw forbidden();
    }
  } else if (STAFF_OR_ADMIN.includes(action)) {
    if (actor.role !== R.ADMIN && actor.role !== R.STAFF) {
      throw forbidden();
    }
  }

  /* ---- 2. Status legality (409 — the target's state, not the caller's). ---- */

  const status = state.verificationStatus;

  switch (action) {
    case "EDIT_PROFILE":
    case "EDIT_CREDENTIALS":
      // ARCHIVED: §5.2 rejects any profile edit of an archived doctor outright
      // — restoring an archived doctor is the audited UNARCHIVE path only, so
      // an edit is exactly the "profile action moving the doctor out of
      // ARCHIVED" §5 forbids.
      if (status === S.ARCHIVED) {
        throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived. Un-archive it first.");
      }
      // REJECTED is terminal for every normal transition (§5) — unlike
      // ARCHIVED it has no admin escape hatch, so this is not "un-archive
      // first" but "a new invite is required".
      if (status === S.REJECTED) {
        throw new AppError(409, "DOCTOR_REJECTED", "This doctor was rejected. A new invitation is required.");
      }
      return;

    case "VERIFY":
    case "REJECT":
      // Both are THE decision on a PENDING_VERIFICATION doctor (§5). An admin
      // cannot "verify" an already-VERIFIED doctor (no-op churn in the
      // history) nor an INVITED one (credentials were never submitted).
      if (status !== S.PENDING_VERIFICATION) {
        throw invalidTransition(status, action);
      }
      return;

    case "SUSPEND":
      if (status === S.ARCHIVED) {
        throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is archived; there is nothing to suspend.");
      }
      // Suspension is a state, not an event to repeat: a second suspend would
      // overwrite the original `suspendedAt` and, worse, its reason — the
      // audit trail would show a suspension that never happened at the first
      // timestamp.
      if (state.suspendedAt !== null) {
        throw new AppError(409, "ALREADY_SUSPENDED", "This doctor is already suspended.");
      }
      return;

    case "UNSUSPEND":
      // The mirror: clearing an already-clear suspension is a no-op that would
      // still write an audit row claiming a restoration happened.
      if (state.suspendedAt === null) {
        throw new AppError(409, "NOT_SUSPENDED", "This doctor is not suspended.");
      }
      return;

    case "ARCHIVE":
      // Archiving a suspended doctor IS legal (and clears the suspension):
      // suspend and archive are orthogonal, §5.
      if (status === S.ARCHIVED) {
        throw new AppError(409, "DOCTOR_ARCHIVED", "This doctor is already archived.");
      }
      return;

    case "UNARCHIVE":
      if (status !== S.ARCHIVED) {
        throw new AppError(409, "NOT_ARCHIVED", "This doctor is not archived.");
      }
      return;
  }
}

/**
 * §5's single bookability rule, derived and never stored: "bookable iff
 * VERIFIED AND not suspended". First consumers: Day 13's public list and profile endpoints, then the booking transaction (§5.2's race guard re-reads both columns inside its own transaction — this helper is the definition it applies, so listing and booking can never disagree).
 */
export function isBookable(state: DoctorState): boolean {
  return state.verificationStatus === S.VERIFIED && state.suspendedAt === null;
}
