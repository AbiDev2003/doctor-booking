-- AlterTable: staff follow-up delay, editable in clinic settings.
ALTER TABLE "clinics"
ADD COLUMN "unclosed_booking_reminder_minutes" INTEGER NOT NULL DEFAULT 180;

-- One follow-up per appointment and recipient. The `::notification_type` cast
-- matches the introspected form so `migrate dev` does not propose a DROP/CREATE.
CREATE UNIQUE INDEX "notifications_followup_once_per_appointment_recipient_unique"
  ON "notifications"("appointment_id", "recipient")
  WHERE (type = 'APPOINTMENT_ATTENDANCE_FOLLOW_UP'::notification_type);
