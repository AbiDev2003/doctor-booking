import { Link, NavLink, Outlet } from "react-router-dom";
import type { SessionUser } from "../lib/api";
import { useSession } from "../hooks/useSession";

/**
 * plan.md §26's storefront shell (Day 13): shared nav + footer around the
 * public pages. The right-hand slot of the nav is auth-aware — a signed-in
 * visitor gets a path into the app for their role; a signed-out one gets
 * "Sign in". Nothing here hides content: the public pages themselves only ever
 * render what the unauthenticated API sends.
 *
 * The actionable-role map is the *client's* idea of the fastest useful next
 * step and is deliberately cosmetic — every destination re-checks its own
 * guard on load, so a stale token or an unusual role resolves server-side.
 */
const ROLE_HOMES: Record<SessionUser["role"], string> = {
  ADMIN: "/doctor",
  STAFF: "/doctor",
  DOCTOR: "/doctor",
  PATIENT: "/profile",
};

function AccountLink({ user }: { user: SessionUser | null }) {
  if (!user) return <Link to="/login">Sign in</Link>;
  return <Link to={ROLE_HOMES[user.role]}>{user.role.toLowerCase() === "doctor" ? "My dashboard" : "My account"}</Link>;
}

export default function PublicLayout() {
  const { user, isLoading } = useSession();

  return (
    <>
      <header className="site-nav">
        <Link to="/" className="site-nav__brand">
          Clinic
        </Link>
        <nav className="site-nav__links" aria-label="Main">
          <NavLink to="/doctors">Doctors</NavLink>
          {isLoading ? (
            <span className="site-nav__placeholder" aria-hidden="true" />
          ) : (
            <AccountLink user={user} />
          )}
        </nav>
      </header>

      <main className="page">
        <Outlet />
      </main>

      <footer className="site-footer">Clinic bookings — public site</footer>
    </>
  );
}