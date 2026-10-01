-- Day 6 — the constraints. This file is the double-booking guard, the hold
-- guard and the reminder dedupe key, none of which Prisma can express.
--
-- The four CREATE UNIQUE INDEX statements below are Prisma-generated verbatim
-- from the `where: raw(...)` declarations in schema.prisma. The three
-- ALTER TABLE ... ADD CONSTRAINT ... CHECK statements at the bottom are HAND
-- WRITTEN, because Prisma has no CHECK support in any version and will never
-- generate, introspect or manage them.
--
-- Day 6's spike established that the four partial indexes round-trip cleanly
-- through Prisma 7.10's introspection, so `prisma migrate dev` no longer
-- treats them as drift and does not drop them. See the verification script at
-- server/scripts/assert-constraints.ts, which proves each of these actually
-- rejects a violating write — a migration that applies cleanly is not evidence
-- that a rule exists.

-- CreateIndex
CREATE UNIQUE INDEX "appointments_active_booking_per_patient_slot_unique" ON "appointments"("patient_id", "slot_id") WHERE (status IN ('CONFIRMED', 'ARRIVED'));

-- CreateIndex
CREATE UNIQUE INDEX "notifications_reminder_once_per_appointment_slot_unique" ON "notifications"("appointment_id", "slot_id") WHERE (type = 'REMINDER');

-- CreateIndex
CREATE UNIQUE INDEX "seat_holds_one_live_hold_per_patient_unique" ON "seat_holds"("patient_id") WHERE (released_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "seat_holds_one_live_hold_per_slot_patient_unique" ON "seat_holds"("slot_id", "patient_id") WHERE (released_at IS NULL);

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN. Column names are snake_case because this is raw SQL against the
-- mapped columns; TypeScript never sees this form.
-- ---------------------------------------------------------------------------

-- §8.1 / §15 — a slot can never hold more seats than it has room for. This is
-- the database half of the guarded capacity update: application code moves
-- booked_count/held_count, and this makes an over-count impossible rather than
-- merely unlikely. Note heldCount is a LOWER bound (§8.1), so this can reject
-- nothing while a hold is merely stale — it fails only when the counters are
-- genuinely over.
ALTER TABLE "slots" ADD CONSTRAINT "slots_capacity_check" CHECK (booked_count + held_count <= max_patients);

-- §23 — a slot with zero capacity can never be booked, which would be an
-- unrecoverable state: the row exists, is enabled, and no patient can ever take
-- a seat in it.
ALTER TABLE "slots" ADD CONSTRAINT "slots_max_patients_positive_check" CHECK (max_patients > 0);

-- §17 — money is an Int of paise and is always strictly positive. A zero or
-- negative amount is a reconciliation bug, not a free appointment.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_paise_positive_check" CHECK (amount_paise > 0);