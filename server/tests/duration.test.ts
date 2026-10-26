import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { durationLabel } from "../src/lib/duration.js";

describe("durationLabel", () => {
  it("renders singular units", () => {
    assert.equal(durationLabel("1m"), "1 minute");
    assert.equal(durationLabel("1h"), "1 hour");
    assert.equal(durationLabel("1d"), "1 day");
  });

  it("renders plural units", () => {
    assert.equal(durationLabel("15m"), "15 minutes");
    assert.equal(durationLabel("24h"), "24 hours");
    assert.equal(durationLabel("7d"), "7 days");
  });

  it("falls back to the raw value for an unexpected shape", () => {
    assert.equal(durationLabel("soon"), "soon");
  });
});
