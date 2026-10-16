import { z } from "zod";
import type { $Enums, Prisma } from "../generated/prisma/client.js";

/**
 * Day 20 request/response shapes — the §20 audit read surface (decision 4).
 *
 * The read is ADMIN-only and deliberately narrow: three equality filters that
 * match the indexes (`(target_type, target_id, createdAt)` for the per-target
 * history view, `(createdAt)` for the chronological feed — plan.md §24 index
 * list) plus keyset pagination. No full-text search, no date-range filters, no
 * export: the admin dashboard (Day 33) renders this endpoint, and every query
 * shape it will need is one of these filters.
 *
 * The cursor is an opaque `"<createdAt ISO>|<id>"` string minted by the
 * service (`encodeAuditCursor`); clients never construct one, they only echo
 * back `nextCursor`.
 */

export const listAuditQuerySchema = z.object({
  targetType: z.string().trim().min(1).max(64).optional(),
  targetId: z.uuid("Invalid target id").optional(),
  action: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(160).optional(),
});

export type ListAuditQueryShape = z.infer<typeof listAuditQuerySchema>;

/**
 * One audit row as the API returns it — the §20 record with the actor block
 * intact and timestamps as ISO strings (the schema.prisma AuditLog twin).
 */
export interface AuditLogDto {
  readonly id: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: Prisma.JsonValue | null;
  readonly after: Prisma.JsonValue | null;
  readonly actorId: string | null;
  readonly actorRole: $Enums.UserRole | null;
  readonly actorName: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
}

/** One page of audit rows, newest first, with the keyset cursor for the next page. */
export interface AuditPageDto {
  readonly entries: readonly AuditLogDto[];
  readonly nextCursor: string | null;
}
