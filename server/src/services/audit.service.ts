import type { $Enums } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { DbClient } from "../lib/prisma.js";

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
 * only (the read side lives with whoever queries it), and asserted at the
 * database level by scripts/assert-constraints.ts. No `updateAudit`,
 * `deleteAudit`, or upsert will be added.
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
