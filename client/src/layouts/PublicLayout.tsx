import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { Mail, Menu, Phone, Stethoscope, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useSession } from "../hooks/useSession";
import { apiPublicClinic } from "../lib/api";
import { ROLE_HOMES, ROLE_HOME_LABELS } from "../lib/roleHome";
import { cn } from "../lib/utils";

function navLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    "text-sm font-medium transition-colors hover:text-primary",
    isActive ? "text-primary" : "text-slate-600",
  );
}

export default function PublicLayout() {
  const { user, isLoading } = useSession();
  const clinic = useQuery({ queryKey: ["public", "clinic"], queryFn: apiPublicClinic });
  const [mobileOpen, setMobileOpen] = useState(false);

  const clinicName = clinic.data?.clinic.name ?? "Clinic";
  const accountHref = user ? ROLE_HOMES[user.role] : "/login";
  const accountLabel = user ? ROLE_HOME_LABELS[user.role] : "Sign in";

  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary focus:shadow"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" className="inline-flex items-center gap-2 text-slate-900" onClick={closeMobile}>
            <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
              <Stethoscope className="size-5" aria-hidden="true" />
            </span>
            <span className="text-base font-semibold tracking-tight sm:text-lg">{clinicName}</span>
          </Link>

          <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
            <NavLink to="/doctors" className={navLinkClass}>
              Doctors
            </NavLink>
            <a href="/#featured-doctors" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary">
              Featured
            </a>
            <a href="/#cta" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary">
              CTA
            </a>
            <a href="/#contact" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary">
              Contacts
            </a>
            {isLoading ? (
              <span className="h-9 w-24 animate-pulse rounded-md bg-slate-200" aria-hidden="true" />
            ) : (
              <Button asChild size="sm">
                <Link to={accountHref}>{accountLabel}</Link>
              </Button>
            )}
          </nav>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="public-mobile-nav"
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </Button>
        </div>

        {mobileOpen && (
          <nav
            id="public-mobile-nav"
            className="border-t border-slate-200 bg-white px-4 py-4 md:hidden"
            aria-label="Mobile"
          >
            <div className="mx-auto flex max-w-7xl flex-col gap-3">
              <NavLink to="/doctors" className={navLinkClass} onClick={closeMobile}>
                Doctors
              </NavLink>
              <a href="/#featured-doctors" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary" onClick={closeMobile}>
                Featured
              </a>
              <a href="/#cta" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary" onClick={closeMobile}>
                CTA
              </a>
              <a href="/#contact" className="text-sm font-medium text-slate-600 transition-colors hover:text-primary" onClick={closeMobile}>
                Contacts
              </a>
              {isLoading ? (
                <span className="h-9 w-full animate-pulse rounded-md bg-slate-200" aria-hidden="true" />
              ) : (
                <Button asChild className="w-full">
                  <Link to={accountHref} onClick={closeMobile}>
                    {accountLabel}
                  </Link>
                </Button>
              )}
            </div>
          </nav>
        )}
      </header>

      <main id="main-content" className="flex-1">
        <Outlet />
      </main>

      <footer id="contact" className="border-t border-slate-200 bg-slate-100">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1.2fr]">
            <div>
              <Link to="/" className="inline-flex items-center gap-2 text-slate-900">
                <span className="inline-flex size-9 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
                  <Stethoscope className="size-5" aria-hidden="true" />
                </span>
                <span className="text-base font-semibold tracking-tight">{clinicName}</span>
              </Link>
              <p className="mt-4 max-w-sm text-sm leading-6 text-slate-600">
                Find trusted doctors, view transparent consultation fees, and book appointments with confidence.
              </p>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-900">Quick links</p>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                <li>
                  <Link to="/" className="transition-colors hover:text-primary">
                    Home
                  </Link>
                </li>
                <li>
                  <Link to="/doctors" className="transition-colors hover:text-primary">
                    Doctors
                  </Link>
                </li>
                <li>
                  <Link to={accountHref} className="transition-colors hover:text-primary">
                    {accountLabel}
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-900">Booking</p>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                <li>
                  <Link to="/doctors" className="transition-colors hover:text-primary">
                    Browse doctors
                  </Link>
                </li>
                <li>
                  <a href="/#featured-doctors" className="transition-colors hover:text-primary">
                    Featured doctors
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-900">Contact</p>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                <li>
                  <a href="tel:+919876543210" className="inline-flex items-center gap-2 transition-colors hover:text-primary">
                    <Phone className="size-4 text-primary" aria-hidden="true" />
                    +91 98765 43210
                  </a>
                </li>
                <li>
                  <a href="mailto:contact@citycareclinic.com" className="inline-flex items-center gap-2 transition-colors hover:text-primary">
                    <Mail className="size-4 text-primary" aria-hidden="true" />
                    contact@citycareclinic.com
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-3 border-t border-slate-200 pt-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p>&copy; {new Date().getFullYear()} {clinicName}. All rights reserved.</p>
            <p>Care you can book with confidence.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}