import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideLockout,
  evaluateWindowCap,
  requiredFailureRows,
  type AttemptEvent,
  type LockoutPolicy,
} from "../src/services/rateLimit.service.js";

/**
 * §6.3's policy at its plan-fixed values. Written out literally rather than read
 * from `config` on purpose: `time.ts` takes its timezone as a required argument
 * for the same reason. A test that read `LOCKOUT_WINDOW` would silently start
 * testing a different policy the day somebody tuned it, and the escalation ladder
 * is exactly the thing that must not move.
 */
const MINUTE = 60_000;

const POLICY: LockoutPolicy = {
  failuresPerWindow: 5,
  baseWindowMs: 15 * MINUTE,
  maxWindowMs: 60 * MINUTE,
};

const NOW = new Date("2026-03-01T12:00:00.000Z");

/**
 * `count` attempts, newest last, `spreadMinutes` apart, ending `endOffsetMinutes`
 * before `NOW`. The offset exists because "spaced 30 minutes apart" and "old"
 * are different claims: a run of three spaced 30 minutes apart that still ends
 * at `NOW` has its newest attempt inside the window, which is not what a test
 * about *stale* attempts means.
 */
function run(count: number, spreadMinutes = 1, endOffsetMinutes = 0): AttemptEvent[] {
  const end = NOW.getTime() - endOffsetMinutes * MINUTE;

  return Array.from({ length: count }, (_, index) => ({
    createdAt: new Date(end - (count - 1 - index) * spreadMinutes * MINUTE),
  }));
}

describe("durationToMs / requiredFailureRows", () => {
  it("needs only enough rows to reach the escalation cap", () => {
    // 5 for the base level, plus one window per doubling (15 -> 30 -> 60).
    assert.equal(requiredFailureRows(POLICY), 15);
  });

  it("still asks for at least one window when base and cap are equal", () => {
    assert.equal(
      requiredFailureRows({ failuresPerWindow: 5, baseWindowMs: 15 * MINUTE, maxWindowMs: 15 * MINUTE }),
      5,
    );
  });
});

describe("evaluateWindowCap — the IP key and both OTP limits", () => {
  const limit = 3;
  const windowMs = 15 * MINUTE;

  it("allows an empty history", () => {
    const decision = evaluateWindowCap([], NOW, limit, windowMs);
    assert.equal(decision.limited, false);
    assert.equal(decision.retryAfterSeconds, 0);
  });

  it("allows one below the limit", () => {
    assert.equal(evaluateWindowCap(run(2), NOW, limit, windowMs).limited, false);
  });

  it("caps exactly at the limit", () => {
    const decision = evaluateWindowCap(run(3), NOW, limit, windowMs);
    assert.equal(decision.limited, true);
    assert.equal(decision.count, 3);
  });

  it("ignores events that have aged out of the window", () => {
    // Two inside the 15-minute window, three well outside it: the recent 2 is
    // what matters, not 5 in total, or a busy account would lock itself out
    // over a long afternoon.
    const inside = run(2);
    const stale = run(3, 30, 30);
    assert.equal(evaluateWindowCap([...inside, ...stale], NOW, limit, windowMs).limited, false);
  });

  it("treats the window edge as outside the window", () => {
    const onTheEdge: AttemptEvent[] = [{ createdAt: new Date(NOW.getTime() - windowMs) }];
    assert.equal(evaluateWindowCap(onTheEdge, NOW, 1, windowMs).limited, false);
  });

  it("reports the wait until the cap clears, not the whole window", () => {
    // 3 attempts 5 minutes apart: the oldest is 10 min old, so it leaves the
    // 15-minute window in 5 minutes — not in 15.
    const decision = evaluateWindowCap(run(3, 5), NOW, limit, windowMs);
    assert.equal(decision.limited, true);
    assert.equal(decision.retryAfterSeconds, 5 * 60);
  });

  it("never reports a zero-second wait while capped", () => {
    // The threshold event is inside the window, so unlockAt > now — but a caller
    // that trusts a 0 and retries instantly would be correct only by luck. §6.3
    // says blocked requests get a Retry-After, so it is at least 1.
    const decision = evaluateWindowCap(run(3), NOW, limit, windowMs);
    assert.ok(decision.retryAfterSeconds >= 1);
  });

  it("counts every attempt, successful or not", () => {
    // The IP cap is a volume cap, not a correctness cap: the caller filters
    // nothing out, so a table of mixed outcomes must still trip it.
    assert.equal(evaluateWindowCap(run(5), NOW, limit, windowMs).count, 5);
  });
});

describe("decideLockout — §6.3's escalating identity lockout", () => {
  it("does not lock below the threshold", () => {
    const decision = decideLockout(run(4), NOW, POLICY);
    assert.equal(decision.limited, false);
    assert.equal(decision.level, 0);
    assert.equal(decision.windowMs, 15 * MINUTE);
  });

  it("locks at exactly 5 failures, for 15 minutes", () => {
    const decision = decideLockout(run(5), NOW, POLICY);
    assert.equal(decision.limited, true);
    assert.equal(decision.level, 0);
    assert.equal(decision.windowMs, 15 * MINUTE);
  });

  it("counts down from the window edge, not from the newest failure", () => {
    // 5 failures a minute apart: the oldest is already 4 minutes old, so it
    // leaves the 15-minute window in 11, and the count drops below 5 then. This
    // is deliberate — retryAfter is when the caller can actually get back in, not
    // how long the policy nominally locks for.
    const decision = decideLockout(run(5), NOW, POLICY);
    assert.equal(decision.retryAfterSeconds, 11 * 60);
  });

  it("locks regardless of the order timestamps arrive in", () => {
    const ordered = run(5);
    const shuffled = [...ordered].reverse();
    assert.equal(decideLockout(shuffled, NOW, POLICY).limited, decideLockout(ordered, NOW, POLICY).limited);
  });

  it("escalates to 30 minutes at 10 failures", () => {
    const decision = decideLockout(run(10), NOW, POLICY);
    assert.equal(decision.limited, true);
    assert.equal(decision.level, 1);
    assert.equal(decision.windowMs, 30 * MINUTE);
  });

  it("escalates to the 60 minute cap at 15 failures", () => {
    const decision = decideLockout(run(15), NOW, POLICY);
    assert.equal(decision.level, 2);
    assert.equal(decision.windowMs, 60 * MINUTE);
  });

  it("stays at the cap however long the run gets", () => {
    // 20, 25, 40 — the ladder saturates rather than growing without bound.
    for (const count of [20, 25, 40]) {
      const decision = decideLockout(run(count), NOW, POLICY);
      assert.equal(decision.level, 2, `${count} failures`);
      assert.equal(decision.windowMs, 60 * MINUTE, `${count} failures`);
    }
  });

  it("locks for the escalated window, not the base window", () => {
    // 10 failures 3 minutes apart span 27 minutes, so 5 of them sit inside the
    // base 15-minute window too. A level-0 reading would answer "locked, but only
    // for 15 minutes"; the run length says this is the second lockout, so the
    // answer is 30. This is the whole reason the level is derived rather than
    // assumed to be zero.
    const decision = decideLockout(run(10, 3), NOW, POLICY);
    assert.equal(decision.limited, true);
    assert.equal(decision.windowMs, 30 * MINUTE);
    // The 5th-newest failure is 12 minutes old, so it leaves the 30-minute
    // window in 18 — the wait, as above, runs from the window edge.
    assert.equal(decision.retryAfterSeconds, 18 * 60);
  });

  it("does not lock a run that is too spread out for its own window", () => {
    // The counterpart to the test above, and the reason the level and the window
    // are separate. 10 failures 20 minutes apart span three hours, so only 2 fall
    // inside the 30-minute window this level would use — under the threshold, so
    // nobody is locked. A fortnight of typos must not cost anyone their account.
    const decision = decideLockout(run(10, 20), NOW, POLICY);
    assert.equal(decision.level, 1);
    assert.equal(decision.limited, false);
  });

  it("releases the lock once the failures age out", () => {
    // The same 5 failures, 20 minutes earlier: the run is still the same length,
    // but none of it is inside the window any more.
    assert.equal(decideLockout(run(5, 1, 20), NOW, POLICY).limited, false);
  });

  it("honours a custom policy", () => {
    // What a developer gets from LOCKOUT_FAILURES=2 in .env — the reason the
    // policy is an argument and not a config read inside the function.
    const strict: LockoutPolicy = { failuresPerWindow: 2, baseWindowMs: 5 * MINUTE, maxWindowMs: 20 * MINUTE };
    assert.equal(decideLockout(run(2), NOW, strict).limited, true);
    assert.equal(decideLockout(run(4), NOW, strict).level, 1);
    assert.equal(decideLockout(run(4), NOW, strict).windowMs, 10 * MINUTE);
  });
});
