-- AlterEnum
-- Kept in its own migration: PostgreSQL will not let a later statement in the
-- same transaction USE a value that was just added to an enum.
ALTER TYPE "notification_type" ADD VALUE 'APPOINTMENT_ATTENDANCE_FOLLOW_UP';
