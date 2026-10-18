/**
 * plan.md §3.2 / §14 / §24 — the ONE way a consultation price is derived.
 *
 * The expression `profile.consultationFee ?? clinic.defaultConsultationFee`
 * began inline in Day 19's booking transaction, where it became the
 * `feeAmount` booking-time snapshot. Day 23 needs the SAME number before any
 * appointment exists: the amount a patient is asked to pay on the Razorpay
 * order must equal the snapshot the booking transaction will later write, or
 * the two paths drift the moment a fee edit lands between them. One function,
 * both callers, one number — the order and the appointment can no longer
 * disagree about what was agreed.
 *
 * `??`, not `||`: a doctor whose profile says fee 0 keeps 0 (a deliberate
 * free clinic), while a profile with no fee set at all (`null`) falls back to
 * the clinic default. The caller that actually CHARGES this number is
 * responsible for refusing `<= 0` where a CHECK forbids it (the Day 6
 * `CHECK (amount_paise > 0)` on `payments` — see paymentOrder.service.ts).
 */
export function deriveConsultationFee(
  consultationFee: number | null | undefined,
  clinicDefaultFee: number,
): number {
  return consultationFee ?? clinicDefaultFee;
}
