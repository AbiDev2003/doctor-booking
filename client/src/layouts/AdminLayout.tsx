import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * §29's admin shell (Day 33): the tabs an ADMIN owns that STAFF must not see.
 *
 * A convenience guard only. Every `/api/v1/admin/*` route re-checks ADMIN
 * server-side, and the mutations the dashboard drives keep their own gates.
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  )
}

const TABS = [
  { to: "/admin", end: true, label: "Overview" },
  { to: "/admin/doctors", label: "Doctors" },
  { to: "/admin/patients", label: "Patients" },
  { to: "/admin/appointments", label: "Appointments" },
  { to: "/admin/schedule", label: "Schedule" },
  { to: "/admin/payments", label: "Payments" },
  { to: "/admin/notifications", label: "Notifications" },
  { to: "/admin/audit", label: "Audit" },
  { to: "/admin/settings", label: "Settings" },
] as const

export default function AdminLayout() {
  const { user, isLoading } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/admin")}`} replace />
  }
  if (user.role !== "ADMIN") {
    return <Navigate to="/staff" replace />
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
          <Link to="/admin" className="font-bold text-foreground">
            Clinic · Admin
          </Link>
          <nav aria-label="Admin dashboard" className="flex flex-wrap items-center gap-1">
            {TABS.map((tab) => (
              <NavLink key={tab.to} to={tab.to} end={"end" in tab ? tab.end : false} className={navClass}>
                {tab.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <Link
              to="/staff"
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Front desk
            </Link>
            <Link
              to="/profile"
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Profile
            </Link>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
