import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { assertDoctorAction, isBookable } from "../src/lib/doctorState.js";
import type { DoctorAction, DoctorState } from "../src/lib/doctorState.js";

/**
 * Day 12's DoD, literally: "the §5 transition matrix is enforced; role limits
 * hold." The matrix is pure (lib/doctorState.ts), so this file is the proof —
 * no database, no harness (the DB-backed one arrives Day 35), and therefore
 * no excuse to leave the proof until then.
 *
 * The shape is exhaustive rather than example-based: every state the schema
 * can hold (5 statuses × suspension on/off) × every action × every role —
 * 320 combinations, each asserted ALLOWED or REFUSED. An example-based suite
 * proves the cases someone remembered; a table proves the ones nobody did.
 * The ALLOWED table below is transcribed from plan.md §5/§5.2 by hand, NOT
 * derived from the implementation, so a rule change must be a deliberate
 * edit in two places — that friction is the point.
 *
 * Refusals are further split the way the matrix orders its own checks:
 * a role the caller does not hold is 403 FORBIDDEN (and the message must be
 * the generic one — no probing learns which roles exist), while a legal role
 * on an illegal state is 409. PATIENT is asserted against every combination,
 * because "never a legal actor" is a property over the whole space, not a row.
 */

const S = $Enums.DoctorVerificationStatus;
const R = $Enums.UserRole;

type Status = $Enums.DoctorVerificationStatus;

interface Row {
  readonly status: Status;
  readonly suspended: boolean;
  /** action → the roles that may perform it HERE. Everything else is refused. */
  readonly allowed: Partial<Record<DoctorAction, readonly $Enums.UserRole[]>>;
}

const EDITS: readonly $Enums.UserRole[] = [R.DOCTOR, R.STAFF, R.ADMIN];
const STAFF_OR_ADMIN: readonly $Enums.UserRole[] = [R.STAFF, R.ADMIN];
const ADMIN: readonly $Enums.UserRole[] = [R.ADMIN];

/**
 * §5 + §5.2, transcribed. Suspension is orthogonal by construction: compare
 * the suspended/unsuspended rows of the same status — only SUSPEND/UNSUSPEND
 * differ, every other action is identical (the §5 rule that suspension may
 * not become a second, hidden status column).
 */
const TABLE: readonly Row[] = [
  {
    status: S.INVITED,
    suspended: false,
    allowed: { EDIT_PROFILE: EDITS, EDIT_CREDENTIALS: EDITS, SUSPEND: STAFF_OR_ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  {
    status: S.INVITED,
    suspended: true,
    allowed: { EDIT_PROFILE: EDITS, EDIT_CREDENTIALS: EDITS, UNSUSPEND: ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  {
    status: S.PENDING_VERIFICATION,
    suspended: false,
    allowed: {
      EDIT_PROFILE: EDITS,
      EDIT_CREDENTIALS: EDITS,
      VERIFY: ADMIN,
      REJECT: ADMIN,
      SUSPEND: STAFF_OR_ADMIN,
      ARCHIVE: STAFF_OR_ADMIN,
    },
  },
  {
    status: S.PENDING_VERIFICATION,
    suspended: true,
    allowed: {
      EDIT_PROFILE: EDITS,
      EDIT_CREDENTIALS: EDITS,
      VERIFY: ADMIN,
      REJECT: ADMIN,
      UNSUSPEND: ADMIN,
      ARCHIVE: STAFF_OR_ADMIN,
    },
  },
  {
    status: S.VERIFIED,
    suspended: false,
    allowed: { EDIT_PROFILE: EDITS, EDIT_CREDENTIALS: EDITS, SUSPEND: STAFF_OR_ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  {
    status: S.VERIFIED,
    suspended: true,
    allowed: { EDIT_PROFILE: EDITS, EDIT_CREDENTIALS: EDITS, UNSUSPEND: ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  // REJECTED: edits are gone (terminal — "a new invitation is required"),
  // but §5's off-boarding verbs still reach it: a rejected doctor may still
  // be suspended (while pending an invite decision they might already be
  // booked) or archived outright.
  {
    status: S.REJECTED,
    suspended: false,
    allowed: { SUSPEND: STAFF_OR_ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  {
    status: S.REJECTED,
    suspended: true,
    allowed: { UNSUSPEND: ADMIN, ARCHIVE: STAFF_OR_ADMIN },
  },
  // ARCHIVED: terminal except UNARCHIVE. The (archived, suspended) row can
  // never be produced by the service — archive clears suspension — but the
  // matrix is a pure function and judges what it is asked; recording the
  // judgment keeps the table total instead of silently half-defined.
  { status: S.ARCHIVED, suspended: false, allowed: { UNARCHIVE: ADMIN } },
  { status: S.ARCHIVED, suspended: true, allowed: { UNSUSPEND: ADMIN, UNARCHIVE: ADMIN } },
];

const ACTIONS: readonly DoctorAction[] = [
  "EDIT_PROFILE",
  "EDIT_CREDENTIALS",
  "VERIFY",
  "REJECT",
  "SUSPEND",
  "UNSUSPEND",
  "ARCHIVE",
  "UNARCHIVE",
];

const ROLES: readonly $Enums.UserRole[] = [R.PATIENT, R.DOCTOR, R.STAFF, R.ADMIN];

/** Every role the action admits in ANY state — used to tell 403 from 409. */
const ROLES_BY_ACTION: Record<DoctorAction, readonly $Enums.UserRole[]> = {
  EDIT_PROFILE: EDITS,
  EDIT_CREDENTIALS: EDITS,
  VERIFY: ADMIN,
  REJECT: ADMIN,
  SUSPEND: STAFF_OR_ADMIN,
  UNSUSPEND: ADMIN,
  ARCHIVE: STAFF_OR_ADMIN,
  UNARCHIVE: ADMIN,
};

function stateOf(row: Row): DoctorState {
  return { verificationStatus: row.status, suspendedAt: row.suspended ? new Date(1_700_000_000_000) : null };
}

/** The AppError `fn` threw, or null when it completed. */
function caught(fn: () => void): AppError | null {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    return err;
  }
}

function label(row: Row, action: DoctorAction, role: $Enums.UserRole): string {
  return `${row.status}${row.suspended ? "+suspended" : ""} × ${action} × ${role}`;
}

describe("§5 transition matrix — exhaustive role × state table", () => {
  let allowedCount = 0;
  let refusedCount = 0;

  for (const row of TABLE) {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        it(label(row, action, role), () => {
          const expectedRoles = row.allowed[action];
          const shouldAllow = expectedRoles?.includes(role) ?? false;
          const err = caught(() => assertDoctorAction(stateOf(row), action, { role }));

          if (shouldAllow) {
            assert.equal(err, null, `expected ALLOWED, got ${err?.code}`);
            allowedCount += 1;
            return;
          }

          refusedCount += 1;
          assert.ok(err, "expected a refusal");
          const roleAdmits = ROLES_BY_ACTION[action].includes(role);
          if (!roleAdmits) {
            // The generic message is part of the assertion, not decoration:
            // it is what stops an endpoint-probing caller from learning the
            // role set from the refusal's prose.
            assert.equal(err.status, 403);
            assert.equal(err.code, "FORBIDDEN");
            assert.equal(err.message, "You do not have access to this resource");
          } else {
            assert.equal(err.status, 409, `expected 409 for a state refusal, got ${err.status}`);
          }
        });
      }
    }
  }

  it(`exercised the full space (${allowedCount} allowed / ${refusedCount} refused of ${TABLE.length * ACTIONS.length * ROLES.length})`, () => {
    assert.equal(allowedCount + refusedCount, TABLE.length * ACTIONS.length * ROLES.length);
    assert.ok(allowedCount > 0, "the allowed side of the table must not be empty");
    assert.ok(refusedCount > 0, "the refused side of the table must not be empty");
  });
});

describe("§5 matrix — refusal codes are specific (legitimate clients branch on code)", () => {
  const verified: DoctorState = { verificationStatus: S.VERIFIED, suspendedAt: null };
  const archived: DoctorState = { verificationStatus: S.ARCHIVED, suspendedAt: null };
  const rejected: DoctorState = { verificationStatus: S.REJECTED, suspendedAt: null };
  const pending: DoctorState = { verificationStatus: S.PENDING_VERIFICATION, suspendedAt: null };
  const verifiedSuspended: DoctorState = { verificationStatus: S.VERIFIED, suspendedAt: new Date() };

  const cases: readonly [DoctorState, DoctorAction, $Enums.UserRole, string][] = [
    [archived, "EDIT_CREDENTIALS", R.ADMIN, "DOCTOR_ARCHIVED"],
    [rejected, "EDIT_PROFILE", R.ADMIN, "DOCTOR_REJECTED"],
    [verified, "VERIFY", R.ADMIN, "INVALID_STATE_TRANSITION"],
    [pending, "REJECT", R.STAFF, "FORBIDDEN"], // role before state — 403 wins
    [verifiedSuspended, "SUSPEND", R.STAFF, "ALREADY_SUSPENDED"],
    [verified, "UNSUSPEND", R.ADMIN, "NOT_SUSPENDED"],
    [archived, "ARCHIVE", R.STAFF, "DOCTOR_ARCHIVED"],
    [verified, "UNARCHIVE", R.ADMIN, "NOT_ARCHIVED"],
  ];

  for (const [state, action, role, code] of cases) {
    it(`${action} on ${state.verificationStatus}${state.suspendedAt ? "+suspended" : ""} by ${role} → ${code}`, () => {
      const err = caught(() => assertDoctorAction(state, action, { role }));
      assert.ok(err, "expected a refusal");
      assert.equal(err.code, code);
    });
  }
});

describe("isBookable — §5's derived rule (VERIFIED and not suspended)", () => {
  const cases: readonly [Status, boolean, boolean][] = [
    [S.INVITED, false, false],
    [S.PENDING_VERIFICATION, false, false],
    [S.VERIFIED, false, true],
    [S.VERIFIED, true, false],
    [S.REJECTED, false, false],
    [S.ARCHIVED, false, false],
  ];

  for (const [status, suspended, expected] of cases) {
    it(`${status}${suspended ? "+suspended" : ""} → ${expected}`, () => {
      const state: DoctorState = {
        verificationStatus: status,
        suspendedAt: suspended ? new Date() : null,
      };
      assert.equal(isBookable(state), expected);
    });
  }
});
