import type { SessionUser } from "./api";

/**
 * "Where does this role belong?" — asked in three places that used to answer
 * it independently: the post-login redirect (`pages/Login.tsx`), the public
 * nav's signed-in link (`layouts/PublicLayout.tsx`), and the `/profile` back
 * link. The copies had already drifted (the public nav sent an ADMIN to
 * `/staff` while Login sent the same admin to `/admin`), and every new surface
 * was a chance for a fourth answer.
 *
 * One table, many readers. It is the CLIENT's idea of a role's front door and
 * is deliberately cosmetic: each destination re-checks its own role guard on
 * load and every API call re-checks on the server, so a wrong entry here would
 * be a bad link, never an access-control hole.
 *
 * An ADMIN legitimately has two surfaces — `/admin` (the dashboard) and
 * `/staff` (the front desk, which StaffLayout and the staff API both admit
 * ADMIN to). This table names the dashboard as the home; the shells cross-link
 * to the other one explicitly.
 */
export const ROLE_HOMES: Record<SessionUser["role"], string> = {
  ADMIN: "/admin",
  STAFF: "/staff",
  DOCTOR: "/doctor",
  PATIENT: "/patient",
};

/** The human name of that destination, for nav links and the back link. */
export const ROLE_HOME_LABELS: Record<SessionUser["role"], string> = {
  ADMIN: "Admin dashboard",
  STAFF: "Front desk",
  DOCTOR: "Doctor dashboard",
  PATIENT: "Patient dashboard",
};
