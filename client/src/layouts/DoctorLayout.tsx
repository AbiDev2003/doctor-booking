import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * §28's doctor shell (Day 31): the role guard and the tab bar around every
 * dashboard page.
 *
 * The guard is intentionally cheap-visual, not a security boundary: a DOCTOR
 * route on the server re-checks `requireRole(DOCTOR)` per request, so this page
 * navigating an impostor away is kindness, not the enforcement. A signed-in
 * non-doctor is sent to their own front door rather than shown a tab bar they
 * cannot use.
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  )
}

export default function DoctorLayout() {
  const { user, isLoading } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Doctor dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/doctor")}`} replace />
  }
  if (user.role !== "DOCTOR") {
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
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/doctor" className="font-bold text-foreground">
            Clinic
          </Link>
          <nav aria-label="Doctor dashboard" className="flex flex-wrap items-center gap-1">
            <NavLink to="/doctor" end className={navClass}>
              Overview
            </NavLink>
            <NavLink to="/doctor/queue" className={navClass}>
              Queue
            </NavLink>
            <NavLink to="/doctor/schedule" className={navClass}>
              Schedule
            </NavLink>
            <NavLink to="/doctor/profile" className={navClass}>
              Profile
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

      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
