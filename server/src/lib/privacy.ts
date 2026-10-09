/**
 * §28's "masked contact" — the one place that decides how a phone number is
 * shown to someone who is not the owner (the doctor's live queue today, the
 * staff dashboard on Day 32).
 *
 * The mask happens SERVER-side, never on the client, on purpose: masking in
 * the browser means the full E.164 number already crossed the wire to a
 * device §7 does not trust with it — masking is then decoration, not privacy.
 *
 * The rule is deliberately small and boring: everything gone but the last four
 * digits, so a desk user glancing at a queue can disambiguate two patients who
 * share a name without being handed a full national number. If a call is ever
 * genuinely needed, the desk flow is a separate, audited action — not the
 * queue response.
 */
export function maskContact(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) {
    // A malformed value must not degrade into leaking: fewer than four digits
    // means there are no digits we may show at all.
    return "••••";
  }
  return `••••${digits.slice(-4)}`;
}