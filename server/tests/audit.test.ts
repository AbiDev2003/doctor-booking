import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { AppError } from "../src/lib/appError.js";
import { encodeAuditCursor, parseAuditCursor } from "../src/lib/auditCursor.js";

/**
 * Day 20 — the §§ 20 audit contracts that can be pinned with no database.
 *
 * Two things are proven here:
 *
 * 1. **The keyset cursor round-trips and rejects foreign input.** The cursor
 *    is client-controlled, so a cursor this API did not mint must be a 422,
 *    never a 500 or a silently-wrong page. This is the pure half of the
 *    `listAuditEntries` read; the query itself is proven by `day20-dod.ts`
 *    against the real database.
 * 2. **The audit data layer is insert-and-read only.** §20 forbids *any*
 *    update or delete path, and says so as an application-level property, not
 *    only a database one. The source of `audit.service.ts` is read as text and
 *    asserted to contain no `auditLog.update`/`delete`/`upsert` call and to
 *    export no `updateAudit`/`deleteAudit`-style mutator. Reading the module's
 *    text rather than importing it is deliberate: importing `audit.service.ts`
 *    would pull in `config`/`prisma`, which the unit suite must never need
 *    (the `scripts/assert-constraints.ts` header states the same rule for the
 *    DB suite).
 */

const SERVICE_SOURCE = readFileSync(new URL("../src/services/audit.service.ts", import.meta.url), "utf8");

describe("audit cursor — keyset round-trip", () => {
  it("parses back exactly the (createdAt, id) it encoded", () => {
    const row = { createdAt: new Date("2026-10-15T04:30:00.123Z"), id: "018f2a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6b" };
    const parsed = parseAuditCursor(encodeAuditCursor(row));

    assert.equal(parsed.createdAt.getTime(), row.createdAt.getTime());
    assert.equal(parsed.id, row.id);
  });

  it("keeps millisecond precision — two same-millisecond rows get distinct cursors", () => {
    const createdAt = new Date("2026-10-15T04:30:00.123Z");
    const a = encodeAuditCursor({ createdAt, id: "018f2a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6b" });
    const b = encodeAuditCursor({ createdAt, id: "018f2a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6c" });

    assert.notEqual(a, b, "same instant, different id must not collapse to one cursor");
  });

  it("rejects a cursor with no separator, a bad date, or a non-uuid id as 422", () => {
    for (const raw of ["", "not-a-cursor", "2026-10-15T04:30:00.123Z|", "garbage|018f2a3b-4c5d-7e8f-9a0b-1c2d3e4f5a6b", "2026-10-15T04:30:00.123Z|not-a-uuid"]) {
      assert.throws(
        () => parseAuditCursor(raw),
        (err: unknown) => err instanceof AppError && err.status === 422 && err.code === "INVALID_AUDIT_CURSOR",
        `expected 422 INVALID_AUDIT_CURSOR for ${JSON.stringify(raw)}`,
      );
    }
  });
});

describe("§20 — audit.service.ts is append-only (insert and read only)", () => {
  it("exports the writer and the reader", () => {
    assert.match(SERVICE_SOURCE, /export\s+async\s+function\s+writeAudit\s*\(/);
    assert.match(SERVICE_SOURCE, /export\s+async\s+function\s+listAuditEntries\s*\(/);
  });

  it("never mutates an existing audit row", () => {
    const forbidden = SERVICE_SOURCE.match(/\.auditLog\.(update|updateMany|delete|deleteMany|upsert)\b/);
    assert.equal(forbidden, null, `audit.service.ts must not call ${forbidden?.[0] ?? ""}`);
  });

  it("exports no update/delete/upsert mutator", () => {
    const mutatorExport = SERVICE_SOURCE.match(
      /export\s+(?:async\s+)?(?:function|const)\s+(updateAudit|deleteAudit|upsertAudit|removeAudit)\b/,
    );
    assert.equal(mutatorExport, null, `audit.service.ts must not export ${mutatorExport?.[0] ?? ""}`);
  });
});
