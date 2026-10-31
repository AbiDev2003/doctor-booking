import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * §29's front-desk shell (Day 32): role guard plus the five tabs the day's
 * work is organised around.
 *
 * Like the patient and doctor shells, this guard is kindness rather than the
 * security boundary — every staff route re-checks ADMIN/STAFF server-side. ADMIN
 * is admitted because an admin can do everything a staff member can; Day 33's
 * admin dashboard adds the surfaces STAFF must never see.
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  )
}

export default function StaffLayout() {
  const { user, isLoading } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Front desk</h1>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/staff")}`} replace />
  }
  if (user.role !== "STAFF" && user.role !== "ADMIN") {
    return <Navigate to="/" replace />
  }

  async function signOut() {
    await apiLogout()
    queryClient.removeQueries({ queryKey: ["me"] })
    navigate("/login")
  }

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/staff" className="font-bold text-foreground">
            Clinic · Front desk
          </Link>
          <nav aria-label="Front desk dashboard" className="flex flex-wrap items-center gap-1">
            <NavLink to="/staff" end className={navClass}>
              Today
            </NavLink>
            <NavLink to="/staff/appointments" className={navClass}>
              Appointments
            </NavLink>
            <NavLink to="/staff/patients" className={navClass}>
              Patients
            </NavLink>
            <NavLink to="/staff/payments" className={navClass}>
              Payments
            </NavLink>
            <NavLink to="/staff/schedule" className={navClass}>
              Schedule
            </NavLink>
            <Link
              to="/"
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Public site
            </Link>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
