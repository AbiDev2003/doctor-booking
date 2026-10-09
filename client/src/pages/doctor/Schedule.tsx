/**
 * §28's schedule placeholder (Day 14). Scheduling — recurring weekly windows
 * that generate Slots (§11) — is Day 15's work; this tab exists so the shell's
 * four sections are real from the moment the dashboard lands, and says so
 * plainly rather than faking an empty calendar.
 */
export default function Schedule() {
  return (
    <div>
      <h1>Schedule</h1>
      <p className="hint">Your weekly windows and generated slots will live here.</p>
      <p className="hint">Scheduling arrives on Day 15.</p>
    </div>
  );
}