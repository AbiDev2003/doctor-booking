-- The runtime cap is read from the single Clinic row, and schema defaults only
-- apply to rows created afterwards. Raise the existing row explicitly so the
-- cap change takes effect without a re-seed.
UPDATE "clinics"
SET "max_active_bookings_per_patient" = 6
WHERE "max_active_bookings_per_patient" = 3;
