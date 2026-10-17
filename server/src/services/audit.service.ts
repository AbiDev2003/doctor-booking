import type { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type DbClient } from "../lib/prisma.js";
import { encodeAuditCursor, type AuditCursor } from "../lib/auditCursor.js";
import type { AuditLogDto, AuditPageDto } from "../schemas/audit.js";

/**
 * plan.md §20 — the append-only audit row, written inside the same transaction
 * as the change it records.
 *
 * **Why it takes a `DbClient` and not the root client.** Every audit row in
 * this system is part of the write it describes: a deactivation without its
 * audit row (§5.1), a password reset without its actor and method (§6.2), a
 * deletion without its before/after PII snapshot (§6.1) are all partial states
 * the plan forbids. Taking the transaction client is what makes "the change and
 * its audit commit together or not at all" a property of the type signature
 * rather than of caller discipline.
 *
 * **Why it throws instead of swallowing.** The one deliberately best-effort
 * write in this codebase is `recordFailureQuietly` (rateLimit.service.ts),
 * where a lost row weakens a limiter by one count and replacing a 401 with a
 * 500 would be worse than the loss. Here the audit row *is* the product: §20
 * requires it, and a silently dropped row is the exact failure an immutable
 * record exists to prevent. Callers that must not fail closed (none today)
 * would need their own documented decision, not a default.
 *
 * **Why there is no update or delete path.** §20: a row is created once and
 * can never be updated or deleted — enforced here by exposing insert-and-read
 * only (`writeAudit` + Day 20's `listAuditEntries`), and asserted at both the
 * database level (`scripts/assert-constraints.ts`) and the module level
 * (`tests/audit.test.ts`, which pins that no mutator is ever exported). No
 * `updateAudit`, `deleteAudit`, or upsert will be added.
 *
 * `action` is free SCREAMING_SNAKE text, never an enum (schema.prisma: AuditLog
 * comment): §20 lists examples, and a closed enum would turn every new audited
 * action into a migration.
 *
 * `targetType` is a lowercase noun — `'user'`, `'slot'`, `'seat_hold'` —
 * matching the words the schema comment and Day 6's constraint script use
 * (`'slot'`), so the polymorphic column reads the same wherever it appears.
 */
export interface AuditEntry {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actor: AuditActor;
  /** Field-level snapshot of what the target looked like before the change. */
  readonly before?: Prisma.InputJsonValue | undefined;
  /** Field-level snapshot after the change — including what was anonymised away. */
  readonly after?: Prisma.InputJsonValue | undefined;
  readonly reason?: string | null | undefined;
  readonly ip?: string | null | undefined;
  readonly requestId?: string | null | undefined;
}

/**
 * The §20 actor block: id + role + a **name snapshot captured at action time**.
 *
 * `name` is required because `AuditLog.actorName` is NOT NULL — the schema
 * makes the name the discriminator for rows with no user behind them (a
 * scheduled job writes `actorName = "system"` with id and role null), so a row
 * without a name would not be an incomplete audit, it would be an unreadable
 * one. `id` and `role` stay optional: an anonymous-by-nature action still has a
 * name to attribute (and a real actor always supplies all three).
 */
export interface AuditActor {
  readonly id?: string | null | undefined;
  readonly role?: $Enums.UserRole | null | undefined;
  readonly name: string;
}

export async function writeAudit(client: DbClient, entry: AuditEntry): Promise<void> {
  await client.auditLog.create({
    data: {
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,

      actorId: entry.actor.id ?? null,
      actorRole: entry.actor.role ?? null,
      actorName: entry.actor.name,

      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,

      // Conditional spread rather than `before: entry.before`: with
      // `exactOptionalPropertyTypes` an explicit `undefined` does not assign to
      // Prisma's optional input, and the difference between "no snapshot
      // supplied" and "snapshot is JSON null" is worth preserving at the type
      // level even though both store as SQL NULL.
      ...(entry.before !== undefined && { before: entry.before }),
      ...(entry.after !== undefined && { after: entry.after }),
    },
  });
}

// ---------------------------------------------------------------------------
// Day 20 — the read side (§20 insert-and-READ; decision 4)
// ---------------------------------------------------------------------------

export interface ListAuditInput {
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly action?: string | undefined;
  readonly limit: number;
  readonly cursor?: AuditCursor | undefined;
}

function toAuditDto(row: {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  actorId: string | null;
  actorRole: $Enums.UserRole | null;
  actorName: string;
  reason: string | null;
  ip: string | null;
  requestId: string | null;
  createdAt: Date;
}): AuditLogDto {
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    actorId: row.actorId,
    actorRole: row.actorRole,
    actorName: row.actorName,
    reason: row.reason,
    ip: row.ip,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Newest-first page of audit rows, keyset-paginated on `(createdAt, id)` —
 * the seek both indexes are built for (`plan.md` §24). `limit + 1` rows are
 * fetched so "is there a next page" is answered without a second COUNT:
 * one more row than the page holds means `nextCursor` is minted from the
 * last row actually returned.
 *
 * Read-only and unscoped by actor on purpose: ADMIN is the one role §20 lets
 * see the whole trail, and the route gate (`routes/audit.ts`) is where that is
 * enforced — same as every other read in this codebase.
 */
export async function listAuditEntries(input: ListAuditInput): Promise<AuditPageDto> {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(input.targetType !== undefined && { targetType: input.targetType }),
      ...(input.targetId !== undefined && { targetId: input.targetId }),
      ...(input.action !== undefined && { action: input.action }),
      ...(input.cursor !== undefined && {
        OR: [
          { createdAt: { lt: input.cursor.createdAt } },
          { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  return {
    entries: page.map(toAuditDto),
    nextCursor: hasMore && last !== undefined ? encodeAuditCursor(last) : null,
  };
}
