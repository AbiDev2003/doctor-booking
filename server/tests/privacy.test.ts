import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { maskContact } from "../src/lib/privacy.js";

describe("maskContact", () => {
  it("keeps only the last four digits of a full E.164 number", () => {
    assert.equal(maskContact("+919876543210"), "••••3210");
  });

  it("does not leak length or country code", () => {
    // The literal is fully dropped, not "…" around the middle: the point is
    // that a glanceable queue shows just enough to tell same-named patients
    // apart, and no more.
    assert.equal(maskContact("+14155552671"), "••••2671");
  });

  it("collapses any spelling to the same four digits", () => {
    // Consistency matters here: a doctor comparing two queue screens must see
    // the same token for the same phone whatever spacing the desk typed.
    assert.equal(maskContact("(98765) 43210"), "••••3210");
    assert.equal(maskContact("98765-43210"), "••••3210");
  });

  it("returns a blanket mask when the value is too short to reveal", () => {
    // Malformed values must not error the queue and must not degrade into
    // showing the whole short number.
    assert.equal(maskContact("07"), "••••");
    assert.equal(maskContact(""), "••••");
  });
});