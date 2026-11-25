import { useState } from "react"
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { CalendarClock, CalendarDays, CreditCard, Globe, LayoutDashboard, LogOut, Menu, Stethoscope, Users, UserRound, X } from "lucide-react"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
import { ROLE_HOMES, ROLE_HOME_LABELS } from "../lib/roleHome"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-blue-50 text-primary shadow-sm ring-1 ring-blue-100"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  )
}

export default function StaffLayout() {
  const { user, isLoading } = useSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
          <div className="h-8 w-48 animate-pulse rounded bg-slate-200" />
          <div className="mt-4 h-24 animate-pulse rounded-2xl bg-white" />
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/staff")}`} replace />
  }
  if (user.role !== "STAFF" && user.role !== "ADMIN") {
    return <Navigate to="/" replace />
  }

  const closeMobileMenu = () => setMobileMenuOpen(false)

  async function signOut() {
    await apiLogout()
    queryClient.removeQueries({ queryKey: ["me"] })
    navigate("/login")
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100/90 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link to="/staff" className="inline-flex items-center gap-2 text-slate-950" aria-label="City Care Clinic front desk" onClick={closeMobileMenu}>
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm shadow-blue-200">
                C
              </span>
              <span className="text-lg font-semibold tracking-tight">City Care Clinic</span>
            </Link>
            <div className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <div className="hidden sm:block">
              <p className="text-sm font-medium text-slate-900">Front desk</p>
              <p className="text-xs text-slate-500">Manage day-to-day clinic operations</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/profile"
              className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 md:inline-flex"
            >
              <UserRound className="size-4" aria-hidden="true" />
              Profile
            </Link>
            <Button variant="outline" size="sm" className="hidden bg-white md:inline-flex" onClick={() => void signOut()}>
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="bg-white md:hidden"
              aria-expanded={mobileMenuOpen}
              aria-controls="staff-mobile-nav"
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className="border-t border-slate-100">
          <nav aria-label="Front desk dashboard" className="mx-auto hidden max-w-7xl flex-wrap gap-1 px-4 py-2 md:flex sm:px-6">
            <NavLink to="/staff" end className={navClass}>
              <LayoutDashboard className="size-4" aria-hidden="true" />
              Today
            </NavLink>
            <NavLink to="/staff/appointments" className={navClass}>
              <CalendarDays className="size-4" aria-hidden="true" />
              Appointments
            </NavLink>
            <NavLink to="/staff/patients" className={navClass}>
              <Users className="size-4" aria-hidden="true" />
              Patients
            </NavLink>
            <NavLink to="/staff/payments" className={navClass}>
              <CreditCard className="size-4" aria-hidden="true" />
              Payments
            </NavLink>
            <NavLink to="/staff/schedule" className={navClass}>
              <CalendarClock className="size-4" aria-hidden="true" />
              Schedule
            </NavLink>
            <NavLink to="/staff/doctors" className={navClass}>
              <Stethoscope className="size-4" aria-hidden="true" />
              Doctors
            </NavLink>
            {user.role === "ADMIN" && (
              <Link
                to={ROLE_HOMES.ADMIN}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                {ROLE_HOME_LABELS.ADMIN}
              </Link>
            )}
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              <Globe className="size-4" aria-hidden="true" />
              Public site
            </Link>
          </nav>

          {mobileMenuOpen && (
            <nav id="staff-mobile-nav" aria-label="Front desk dashboard mobile" className="mx-auto max-w-7xl px-4 py-3 md:hidden sm:px-6">
              <div className="grid gap-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                <NavLink to="/staff" end className={navClass} onClick={closeMobileMenu}>
                  <LayoutDashboard className="size-4" aria-hidden="true" />
                  Today
                </NavLink>
                <NavLink to="/staff/appointments" className={navClass} onClick={closeMobileMenu}>
                  <CalendarDays className="size-4" aria-hidden="true" />
                  Appointments
                </NavLink>
                <NavLink to="/staff/patients" className={navClass} onClick={closeMobileMenu}>
                  <Users className="size-4" aria-hidden="true" />
                  Patients
                </NavLink>
                <NavLink to="/staff/payments" className={navClass} onClick={closeMobileMenu}>
                  <CreditCard className="size-4" aria-hidden="true" />
                  Payments
                </NavLink>
                <NavLink to="/staff/schedule" className={navClass} onClick={closeMobileMenu}>
                  <CalendarClock className="size-4" aria-hidden="true" />
                  Schedule
                </NavLink>
                <NavLink to="/staff/doctors" className={navClass} onClick={closeMobileMenu}>
                  <Stethoscope className="size-4" aria-hidden="true" />
                  Doctors
                </NavLink>
                {user.role === "ADMIN" && (
                  <Link
                    to={ROLE_HOMES.ADMIN}
                    className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    onClick={closeMobileMenu}
                  >
                    {ROLE_HOME_LABELS.ADMIN}
                  </Link>
                )}
                <Link
                  to="/"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  onClick={closeMobileMenu}
                >
                  <Globe className="size-4" aria-hidden="true" />
                  Public site
                </Link>
                <Link
                  to="/profile"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  onClick={closeMobileMenu}
                >
                  <UserRound className="size-4" aria-hidden="true" />
                  Profile
                </Link>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  onClick={() => {
                    closeMobileMenu()
                    void signOut()
                  }}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  Sign out
                </button>
              </div>
            </nav>
          )}
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <Outlet />
      </main>
    </div>
  )
}
