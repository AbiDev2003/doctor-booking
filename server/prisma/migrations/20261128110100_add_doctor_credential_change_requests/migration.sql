-- Doctor-proposed credential edits. The live doctor_profiles row is not
-- touched here: a proposal is stored separately until an admin approves it.
CREATE TABLE "doctor_credential_requests" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "status" "doctor_credential_change_status" NOT NULL DEFAULT 'PENDING',
    "requested_changes" JSONB NOT NULL,
    "previous_values" JSONB NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_by_name" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" UUID,
    "reviewed_by_name" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,

    CONSTRAINT "doctor_credential_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "doctor_credential_requests_doctor_requested_idx"
  ON "doctor_credential_requests"("doctor_id", "requested_at");

CREATE INDEX "doctor_credential_requests_status_requested_idx"
  ON "doctor_credential_requests"("status", "requested_at");

-- A doctor has at most one open proposal; historical approved/rejected rows
-- stay in the table for the audit trail. The cast matches the introspected
-- enum form so `migrate dev` does not propose a DROP/CREATE.
CREATE UNIQUE INDEX "doctor_credential_requests_one_pending_per_doctor_unique"
  ON "doctor_credential_requests"("doctor_id")
  WHERE (status = 'PENDING'::doctor_credential_change_status);

ALTER TABLE "doctor_credential_requests"
  ADD CONSTRAINT "doctor_credential_requests_doctor_fkey"
  FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "doctor_credential_requests"
  ADD CONSTRAINT "doctor_credential_requests_requested_by_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "doctor_credential_requests"
  ADD CONSTRAINT "doctor_credential_requests_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
