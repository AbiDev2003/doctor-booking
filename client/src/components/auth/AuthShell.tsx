import type { ReactNode } from "react"

interface AuthShellProps {
  eyebrow?: string
  title: string
  description?: string
  children: ReactNode
}

export function AuthShell({ eyebrow = "City Care Clinic", title, description, children }: AuthShellProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:py-16">
      <div className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm lg:grid-cols-2">
        <div className="flex items-center px-6 py-8 sm:px-10 sm:py-10 lg:px-12 lg:py-12">
          <div className="w-full max-w-md">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
            {description ? <p className="mt-3 text-base leading-7 text-slate-600">{description}</p> : null}
            <div className="mt-8">{children}</div>
          </div>
        </div>

        <div className="relative min-h-[280px] bg-slate-900 lg:min-h-[640px]">
          <img
            src="https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=1200&q=80"
            alt="Smiling doctor in a clinic"
            className="absolute inset-0 h-full w-full object-cover"
            loading="eager"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-slate-900/35 to-slate-900/20" />
          <div className="absolute inset-0 bg-gradient-to-r from-slate-950/20 to-transparent lg:from-slate-950/30" />
          <div className="relative flex h-full flex-col justify-end p-8 sm:p-10">
            <p className="max-w-md text-2xl font-semibold leading-snug text-white sm:text-3xl">
              “Your health deserves attention, clarity, and care you can trust.”
            </p>
            <p className="mt-4 text-sm font-medium text-blue-100">City Care Clinic</p>
          </div>
        </div>
      </div>
    </div>
  )
}
