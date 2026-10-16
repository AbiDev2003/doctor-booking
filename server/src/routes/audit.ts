import { Router } from "express";
import { $Enums } from "../generated/prisma/client.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { listAuditQuerySchema } from "../schemas/audit.js";
import { parseAuditCursor } from "../lib/auditCursor.js";
import { listAuditEntries } from "../services/audit.service.js";

/**
 * plan.md §20 — the audit read surface, Day 20 (decision 4).
 *
 *   GET /api/v1/audit   newest-first page of AuditLog rows (ADMIN only)
 *
 * The write side has existed since Day 11 (`audit.service.ts`); this is the
 * read half §20's insert-and-read contract allows and the one Day 11's locked
 * decision deferred here ("the minimal writer — Day 20 adds reads/exports").
 * It is API-only: the admin dashboard that renders it is Day 33, and no file
 * export exists in MVP (§42).
 *
 * **ADMIN, not ADMIN/STAFF.** The trail records who did what across the whole
 * clinic — including STAFF's own actions — and plan.md's role table gives ADMIN
 * "View audit logs" while STAFF explicitly "cannot view full audit logs"
 * (their own actions remain audited). STAFF get their operational views
 * (Day 32), not the tape. The gate is the route's only check: this is a read,
 * so there is no service-level role re-enforcement (the double-enforcement
 * pattern protects mutations a miswired route could open up).
 */
export const auditRouter = Router();

auditRouter.use(requireAuth);

const adminOnly = requireRole($Enums.UserRole.ADMIN);

auditRouter.get("/", adminOnly, async (req, res, next) => {
  try {
    const query = listAuditQuerySchema.parse(req.query);
    const page = await listAuditEntries({
      targetType: query.targetType,
      targetId: query.targetId,
      action: query.action,
      limit: query.limit,
      cursor: query.cursor === undefined ? undefined : parseAuditCursor(query.cursor),
    });
    res.status(200).json(page);
  } catch (err) {
    next(err);
  }
});
