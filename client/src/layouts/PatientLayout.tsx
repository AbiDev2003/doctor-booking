import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * §27's patient shell (Day 30): the role guard plus the dashboard tabs.
 *
 * Like `DoctorLayout`, the guard is a UX courtesy, not the security boundary —
 * every patient endpoint re-scopes by `req.user` on the server. A signed-in
 * non-patient is sent to their own front door rather than shown a tab bar they
 * cannot use.
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  )
}

export default function PatientLayout() {
  const { user, isLoading } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Your dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/patient")}`} replace />
  }
  if (user.role !== "PATIENT") {
    return <Navigate to="/" replace />
  }

  async function signOut() {
    await apiLogout()
    queryClient.removeQueries({ queryKey: ["me"] })
    navigate("/login")
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <Link to="/patient" className="font-bold text-foreground">
            Clinic
          </Link>
          <nav aria-label="Patient dashboard" className="flex flex-wrap items-center gap-1">
            <NavLink to="/patient" end className={navClass}>
              Overview
            </NavLink>
            <NavLink to="/patient/appointments" className={navClass}>
              Appointments
            </NavLink>
            <NavLink to="/patient/payments" className={navClass}>
              Payments
            </NavLink>
            <NavLink to="/doctors" className={navClass}>
              Find a doctor
            </NavLink>
            <Link to="/profile" className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
              Account
            </Link>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
