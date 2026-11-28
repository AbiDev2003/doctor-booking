-- Doctor-proposed schedule and time-off edits are queued for admin approval.
-- Separate enums keep the request table self-describing without overloading the
-- credential approval lifecycle.
CREATE TYPE "doctor_schedule_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "doctor_schedule_change_type" AS ENUM (
    'WINDOW_CREATE',
    'WINDOW_UPDATE',
    'WINDOW_DELETE',
    'UNAVAILABILITY_CREATE',
    'UNAVAILABILITY_DELETE'
);

-- Submission alerts admins; decision notices go back to the doctor.
ALTER TYPE "notification_type" ADD VALUE 'DOCTOR_SCHEDULE_CHANGE_REQUESTED';
ALTER TYPE "notification_type" ADD VALUE 'DOCTOR_SCHEDULE_CHANGE_APPROVED';
ALTER TYPE "notification_type" ADD VALUE 'DOCTOR_SCHEDULE_CHANGE_REJECTED';
