import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

import { $Enums } from "../src/generated/prisma/client.js";
import { AppError } from "../src/lib/appError.js";
import { requireRole } from "../src/middleware/rbac.js";
import { requireSelfOrRole } from "../src/lib/ownership.js";
import { registerSchema } from "../src/schemas/auth.js";

/**
 * Day 10's DoD is "each role can only reach its own endpoints; a patient
 * cannot reach a doctor's" — decided (code-plan.md, Day 10) as unit tests on
 * the gates themselves, because the only authenticated route that exists today
 * is `/auth/me`, which every role may reach. Live multi-role proof lands with
 * the first real role-scoped routes (Day 12+) and is recorded as a caveat
 * rather than claimed as met, in the same spirit as Day 9's DoD caveat.
 *
 * No harness needed: both gates are pure functions over `req.user`, so fakes
 * are the whole fixture.
 */

type User = NonNullable<Request["user"]>;

function fakeReq(user?: User): Request {
  // Cast through `unknown`: a fake with only the fields the gates read cannot
  // satisfy express's full Request surface, and building one would test the
  // fake instead of the gate.
  return { user } as unknown as Request;
}

/** Captures what the middleware passed to `next` — an error, or nothing. */
function run(middleware: (req: Request, res: Response, next: NextFunction) => void, user?: User): unknown {
  let forwarded: unknown = "NOT_CALLED";
  middleware(fakeReq(user), {} as Response, (err?: unknown) => {
    forwarded = err;
  });
  return forwarded;
}

const PATIENT: User = { id: "u-1", role: $Enums.UserRole.PATIENT, email: "p@x.com", phone: "+919876543210" };
const DOCTOR: User = { id: "u-2", role: $Enums.UserRole.DOCTOR, email: "d@x.com", phone: null };
const ADMIN: User = { id: "u-3", role: $Enums.UserRole.ADMIN, email: "a@x.com", phone: null };

function expectError(result: unknown, status: number, code: string): void {
  assert.ok(result instanceof AppError, `expected AppError, got ${String(result)}`);
  assert.equal(result.status, status);
  assert.equal(result.code, code);
}

/** The error a throwing helper raised, or null when it did not throw. */
function caught(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("requireRole — §7's role gate", () => {
  it("lets a listed role through", () => {
    assert.equal(run(requireRole($Enums.UserRole.ADMIN), ADMIN), undefined);
  });

  it("lets any of several listed roles through", () => {
    const gate = requireRole($Enums.UserRole.STAFF, $Enums.UserRole.ADMIN);
    assert.equal(run(gate, ADMIN), undefined);
  });

  it("refuses an unlisted role with a generic 403", () => {
    expectError(run(requireRole($Enums.UserRole.DOCTOR), PATIENT), 403, "FORBIDDEN");
  });

  it("keeps a patient off a doctor's gate — the DoD example", () => {
    expectError(run(requireRole($Enums.UserRole.DOCTOR), PATIENT), 403, "FORBIDDEN");
  });

  it("reports 401, not 403, when no user is attached", () => {
    // Saying "forbidden" to an unauthenticated caller implies the opposite of
    // the truth and would send a client hunting for a role it does not have.
    expectError(run(requireRole($Enums.UserRole.PATIENT)), 401, "AUTH_REQUIRED");
  });

  it("one fixed message for every refusal — no role oracle", () => {
    const gate = requireRole($Enums.UserRole.ADMIN);
    const asDoctor = run(gate, DOCTOR) as AppError;
    const asPatient = run(gate, PATIENT) as AppError;
    assert.equal(asDoctor.message, asPatient.message);
  });
});

describe("requireSelfOrRole — §7's ownership gate", () => {
  it("lets the owner through", () => {
    assert.doesNotThrow(() => requireSelfOrRole(fakeReq(PATIENT), PATIENT.id));
  });

  it("lets a staff member onto someone else's resource when listed", () => {
    const staff: User = { ...ADMIN, role: $Enums.UserRole.STAFF };
    assert.doesNotThrow(() => requireSelfOrRole(fakeReq(staff), PATIENT.id, $Enums.UserRole.STAFF));
  });

  it("refuses a patient on another patient's resource", () => {
    const other: User = { ...PATIENT, id: "someone-else" };
    expectError(caught(() => requireSelfOrRole(fakeReq(PATIENT), other.id)), 403, "FORBIDDEN");
  });

  it("refuses a doctor onto a patient resource when only staff are listed", () => {
    expectError(
      caught(() => requireSelfOrRole(fakeReq(DOCTOR), PATIENT.id, $Enums.UserRole.STAFF)),
      403,
      "FORBIDDEN",
    );
  });

  it("reports 401 when the route forgot requireAuth", () => {
    expectError(caught(() => requireSelfOrRole(fakeReq(undefined), PATIENT.id)), 401, "AUTH_REQUIRED");
  });
});

describe("no admin self-registration — §5.1 at the schema boundary", () => {
  it("a role in the registration body is stripped, never stored", () => {
    // registerPatient hardcodes `role: PATIENT`; this proves the request body
    // cannot even carry a role past the schema, so the claim holds at both
    // layers. The seed (Day 6) remains the only creator of the first admin.
    const parsed = registerSchema.parse({
      email: "attacker@x.com",
      password: "password123",
      fullName: "Nice Try",
      phone: "9876543210",
      role: "ADMIN",
    });
    assert.equal("role" in parsed, false);
  });
});
