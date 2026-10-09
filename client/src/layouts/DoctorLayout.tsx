import { Link, NavLink, Navigate, Outlet } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { apiLogout } from "../lib/api";

/**
 * §28's doctor shell (Day 14): the role guard and the tab bar around every
 * dashboard page.
 *
 * The guard is intentionally cheap-visual, not a security boundary: a DOCTOR
 * route on the server re-checks `requireRole(DOCTOR)` per request, so this page
 * navigating an impostor away is kindness, not the enforcement. The one rule it
 * does own is UX — a signed-in non-doctor (staff or patient) must not see the
 * doctor's tab bar, they are sent to their own front door instead.
 */
export default function DoctorLayout() {
  const { user, isLoading } = useSession();

  if (isLoading) {
    return (
      <main className="card">
        <h1>Doctor dashboard</h1>
        <p className="hint">Loading…</p>
      </main>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "DOCTOR") return <Navigate to="/" replace />;

  return (
    <>
      <header className="site-nav site-nav--shell">
        <Link to="/doctor" className="site-nav__brand">
          Clinic
        </Link>
        <nav className="site-nav__links" aria-label="Doctor">
          <NavLink to="/doctor" end>
            Overview
          </NavLink>
          <NavLink to="/doctor/queue">Queue</NavLink>
          <NavLink to="/doctor/profile">Profile</NavLink>
          <NavLink to="/doctor/schedule">Schedule</NavLink>
          <Link to="/">Public site</Link>
          <button type="button" className="site-nav__signout" onClick={() => void apiLogout()}>
            Sign out
          </button>
        </nav>
      </header>

      <main className="page">
        <Outlet />
      </main>
    </>
  );
}