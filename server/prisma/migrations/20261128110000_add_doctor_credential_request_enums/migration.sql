-- Lifecycle of a doctor's proposed credential edit. Kept separate from the
-- table so Postgres can commit the enum value before anything references it.
CREATE TYPE "doctor_credential_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- Admin notification for a doctor-submitted credential change proposal.
ALTER TYPE "notification_type" ADD VALUE 'DOCTOR_CREDENTIAL_CHANGE_REQUESTED';
