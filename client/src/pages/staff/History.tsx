import { AppointmentHistory } from "@/components/appointment-history"
import { apiStaffAppointments } from "@/lib/api"

/**
 * The front desk's clinic-wide History.
 *
 * Same filters, rows and action buttons as the admin History — the only
 * difference is the endpoint and query-key prefix, so staff actions invalidate
 * the desk's cache while admin actions invalidate the admin cache.
 */
export default function History() {
  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Front desk</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Appointment history</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Search every booking across doctors and dates, then close anything still open with the same action buttons used on the day board.
        </p>
      </section>

      <AppointmentHistory
        fetchAppointments={apiStaffAppointments}
        queryKeyPrefix={["staff", "appointments", "history"]}
      />
    </div>
  )
}
