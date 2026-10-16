import { AppError } from "./appError.js";

/**
 * Day 20 — the keyset cursor for the §20 audit read (`listAuditEntries`).
 *
 * Split out of `audit.service.ts` for the same reason `bookingGuard.ts`,
 * `slotGuard.ts` and `availability.ts` are: it is pure string/date arithmetic
 * over a value the service already has, so it is unit-testable with no
 * database and no `config` import (`tests/audit.test.ts`). The service keeps
 * the Prisma read; this module only mints and parses the token a client echoes
 * back.
 *
 * The cursor is an opaque `"<createdAt ISO>|<id>"` pair, not an id alone:
 * `createdAt` has millisecond resolution, and a multi-row transaction — a
 * booking writes both an `AppointmentHistory` row and an `AuditLog` row; a
 * §12 cascade writes one audit row per cancelled appointment — can land two
 * rows in the same millisecond. An id-only seek would then skip or repeat a
 * row, which for an append-only audit trail is the difference between "you
 * saw every row" and "you did not".
 *
 * Ids are Prisma-generated `uuid(7)`, so `id` ordering is chronological within
 * one millisecond; the service's `orderBy: [createdAt desc, id desc]` relies on
 * that, and this module does not need to know it — it just carries the pair.
 */

/** The keyset position: the `(createdAt, id)` of the last row a page returned. */
export interface AuditCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mints the opaque cursor from a row the service just returned. */
export function encodeAuditCursor(row: { readonly createdAt: Date; readonly id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

/**
 * Inverse of `encodeAuditCursor`. A cursor this API did not mint is a 422, not
 * a 500: the input is client-controlled, so it is validated like any other
 * request value rather than trusted into a query.
 */
export function parseAuditCursor(raw: string): AuditCursor {
  const separator = raw.indexOf("|");
  const iso = separator === -1 ? "" : raw.slice(0, separator);
  const id = separator === -1 ? "" : raw.slice(separator + 1);
  const createdAt = new Date(iso);

  if (separator === -1 || iso === "" || Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new AppError(422, "INVALID_AUDIT_CURSOR", "The pagination cursor is not a cursor this API minted.");
  }
  return { createdAt, id };
}
