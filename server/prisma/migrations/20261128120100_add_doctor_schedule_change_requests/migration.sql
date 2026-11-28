-- Doctor-proposed schedule/time-off changes. Nothing here mutates a live
-- schedule, slot, unavailability or booking; an admin applies the payload later.
CREATE TABLE "doctor_schedule_requests" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "type" "doctor_schedule_change_type" NOT NULL,
    "status" "doctor_schedule_change_status" NOT NULL DEFAULT 'PENDING',
    "schedule_id" UUID,
    "unavailability_id" UUID,
    "payload" JSONB NOT NULL,
    "previous_values" JSONB,
    "details" JSONB NOT NULL,
    "affected_preview" INTEGER,
    "reason" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_by_name" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" UUID,
    "reviewed_by_name" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,

    CONSTRAINT "doctor_schedule_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "doctor_schedule_requests_doctor_status_requested_idx"
  ON "doctor_schedule_requests"("doctor_id", "status", "requested_at");

CREATE INDEX "doctor_schedule_requests_status_requested_idx"
  ON "doctor_schedule_requests"("status", "requested_at");

CREATE INDEX "doctor_schedule_requests_requester_requested_idx"
  ON "doctor_schedule_requests"("requested_by_id", "requested_at");

ALTER TABLE "doctor_schedule_requests"
  ADD CONSTRAINT "doctor_schedule_requests_doctor_fkey"
  FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "doctor_schedule_requests"
  ADD CONSTRAINT "doctor_schedule_requests_requested_by_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "doctor_schedule_requests"
  ADD CONSTRAINT "doctor_schedule_requests_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
