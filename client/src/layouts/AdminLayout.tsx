import { useState } from "react"
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  Bell,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Stethoscope,
  UserCog,
  UserRound,
  Users,
  X,
} from "lucide-react"
import { useSession } from "../hooks/useSession"
import { apiLogout } from "../lib/api"
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

const TABS = [
  { to: "/admin", end: true, label: "Overview", icon: LayoutDashboard },
  { to: "/admin/doctors", label: "Doctors", icon: Stethoscope },
  { to: "/admin/staff", label: "Staff", icon: UserCog },
  { to: "/admin/patients", label: "Patients", icon: Users },
  { to: "/admin/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/admin/schedule", label: "Schedule", icon: CalendarClock },
  { to: "/admin/schedule-requests", label: "Schedule requests", icon: ClipboardCheck },
  { to: "/admin/payments", label: "Payments", icon: CreditCard },
  { to: "/admin/notifications", label: "Notifications", icon: Bell },
  { to: "/admin/audit", label: "Audit", icon: ClipboardList },
  { to: "/admin/settings", label: "Settings", icon: Settings },
]

export default function AdminLayout() {
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
    return <Navigate to={`/login?returnTo=${encodeURIComponent("/admin")}`} replace />
  }
  if (user.role !== "ADMIN") {
    return <Navigate to="/" replace />
  }

  async function signOut() {
    await apiLogout()
    queryClient.removeQueries({ queryKey: ["me"] })
    navigate("/login")
  }

  const closeMobileMenu = () => setMobileMenuOpen(false)

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
            <Link to="/admin" className="inline-flex items-center gap-2 text-slate-950" aria-label="City Care Clinic admin dashboard" onClick={closeMobileMenu}>
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm shadow-blue-200">
                C
              </span>
              <span className="text-lg font-semibold tracking-tight">City Care Clinic</span>
            </Link>
            <div className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <div className="hidden sm:block">
              <p className="text-sm font-medium text-slate-900">Admin dashboard</p>
              <p className="text-xs text-slate-500">Clinic oversight and configuration</p>
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
              aria-controls="admin-mobile-nav"
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>

        <div className="border-t border-slate-100">
          <nav aria-label="Admin dashboard" className="mx-auto hidden max-w-7xl flex-wrap gap-1 px-4 py-2 md:flex sm:px-6">
            {TABS.map((tab) => {
              const Icon = tab.icon
              return (
                <NavLink key={tab.to} to={tab.to} end={tab.end} className={navClass}>
                  <Icon className="size-4" aria-hidden="true" />
                  {tab.label}
                </NavLink>
              )
            })}
            <Link
              to="/staff"
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              Front desk
            </Link>
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              <Globe className="size-4" aria-hidden="true" />
              Public site
            </Link>
          </nav>

          {mobileMenuOpen && (
            <nav id="admin-mobile-nav" aria-label="Admin dashboard mobile" className="mx-auto max-w-7xl px-4 py-3 md:hidden sm:px-6">
              <div className="grid gap-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                {TABS.map((tab) => {
                  const Icon = tab.icon
                  return (
                    <NavLink key={tab.to} to={tab.to} end={tab.end} className={navClass} onClick={closeMobileMenu}>
                      <Icon className="size-4" aria-hidden="true" />
                      {tab.label}
                    </NavLink>
                  )
                })}
                <Link
                  to="/staff"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  onClick={closeMobileMenu}
                >
                  Front desk
                </Link>
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
