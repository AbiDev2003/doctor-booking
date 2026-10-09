import { useQuery } from "@tanstack/react-query";
import { apiDoctorToday } from "../../lib/api";
import type { TodayQueueEntry, TodaySlotQueue } from "../../lib/api";

/**
 * §28's live queue (Day 14) — read-only by construction: there is no
 * attendance verb on the DOCTOR role (§13.1 keeps arrival/no-show work for
 * admin and staff), so this page renders a mirrored server fact and nothing
 * here can act on it.
 *
 * Two kinds of emptiness are shown distinctly:
 * - no slot today (e.g. a Sunday with the seeded template) — honest "no
 *   sessions today", not a loading flash;
 * - slots with nobody booked — each window still renders, empty, so the
 *   doctor sees their actual afternoon rather than a void.
 */
export default function Queue() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["doctor", "today"],
    queryFn: () => apiDoctorToday().then((r) => r.queue),
  });

  if (isPending) {
    return (
      <div>
        <h1>Today's queue</h1>
        <p className="hint">Loading…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        <h1>Today's queue</h1>
        <p role="alert">Your queue could not be loaded.</p>
        <button type="button" className="button-secondary" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const morning = data.slots;
  const totalInRoom = morning.reduce((sum, slot) => sum + slot.queue.length, 0);

  return (
    <div>
      <h1>Today's queue</h1>
      <p className="hint">
        {data.date} — {totalInRoom} booking{totalInRoom === 1 ? "" : "s"} across {morning.length} window
        {morning.length === 1 ? "" : "s"}.
      </p>

      {morning.length === 0 && <p className="hint">No sessions are scheduled for today.</p>}

      {morning.map((slot) => (
        <SlotCard key={slot.slotId} slot={slot} />
      ))}
    </div>
  );
}

const STATUS_LABELS: Record<TodayQueueEntry["status"], string> = {
  CONFIRMED: "Booked",
  ARRIVED: "Arrived",
  COMPLETED: "Completed",
  NO_SHOW: "No-show",
};

function SlotCard({ slot }: { slot: TodaySlotQueue }) {
  const time = `${slot.startTime.slice(0, 5)}–${slot.endTime.slice(0, 5)}`;

  return (
    <section className="card card--queue">
      <h2>{time}</h2>

      {slot.queue.length === 0 ? (
        <p className="hint">No bookings in this window.</p>
      ) : (
        <ol className="queue">
          {slot.queue.map((entry) => (
            <li key={entry.appointmentId} className={entry.upNext ? "queue__row queue__row--up-next" : "queue__row"}>
              <div>
                <strong>{entry.patientName}</strong>
                {entry.upNext && <span className="queue__badge">Up next</span>}
              </div>
              <div className="hint">
                {entry.maskedContact} · {STATUS_LABELS[entry.status]}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}