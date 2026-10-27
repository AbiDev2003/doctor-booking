import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeRequestUrl } from "../src/lib/logger.js";

describe("sanitizeRequestUrl", () => {
  it("leaves a URL without a query string alone", () => {
    assert.equal(sanitizeRequestUrl("/api/v1/doctors"), "/api/v1/doctors");
  });

  it("redacts a token while preserving unrelated parameters", () => {
    const sanitized = sanitizeRequestUrl("/api/v1/auth/verify-email?token=live-secret&next=%2Fhome");
    assert.equal(sanitized, "/api/v1/auth/verify-email?token=REDACTED&next=%2Fhome");
    assert.equal(sanitized.includes("live-secret"), false);
  });

  it("redacts every credential parameter, case-insensitively", () => {
    const sanitized = sanitizeRequestUrl("/x?Token=a&OTP=b&code=c&access_token=d&refresh_token=e&signature=f");
    assert.equal(sanitized, "/x?Token=REDACTED&OTP=REDACTED&code=REDACTED&access_token=REDACTED&refresh_token=REDACTED&signature=REDACTED");
  });

  it("does not hide ordinary query values", () => {
    assert.equal(sanitizeRequestUrl("/x?page=2&q=doctor"), "/x?page=2&q=doctor");
  });

  it("keeps a bare credential parameter redacted rather than empty", () => {
    assert.equal(sanitizeRequestUrl("/x?token="), "/x?token=REDACTED");
  });
});
