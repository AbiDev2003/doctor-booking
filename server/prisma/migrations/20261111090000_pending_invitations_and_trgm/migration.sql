-- Invitations no longer create a User at send time (claim-time provisioning).
-- The token lives here because auth_tokens.user_id is a required FK.
CREATE TABLE "pending_invitations" (
    "id" UUID NOT NULL,
    "role" "user_role" NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_id" UUID,
    "claimed_user_id" UUID,
    "ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_invitations_token_hash_key" ON "pending_invitations"("token_hash");
CREATE UNIQUE INDEX "pending_invitations_claimed_user_id_key" ON "pending_invitations"("claimed_user_id");
CREATE UNIQUE INDEX "pending_invitations_live_email_unique" ON "pending_invitations"("email") WHERE (consumed_at IS NULL AND revoked_at IS NULL);
CREATE INDEX "pending_invitations_role_created_at_idx" ON "pending_invitations"("role", "created_at");
CREATE INDEX "pending_invitations_expires_at_idx" ON "pending_invitations"("expires_at");

ALTER TABLE "pending_invitations"
  ADD CONSTRAINT "pending_invitations_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pending_invitations"
  ADD CONSTRAINT "pending_invitations_claimed_user_id_fkey"
  FOREIGN KEY ("claimed_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fuzzy patient-name search ("abonash" -> Abinash / Avinash / Abhinash).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "users_full_name_trgm_idx" ON "users" USING GIN ("full_name" gin_trgm_ops);

-- Backfill existing unclaimed invitations so links already in inboxes keep
-- working. Claimed/active accounts and deactivated rows are deliberately skipped.
INSERT INTO "pending_invitations"
  ("id", "role", "full_name", "email", "token_hash", "expires_at", "ip", "created_at")
SELECT
  gen_random_uuid(),
  u."role",
  u."full_name",
  u."email",
  t."token_hash",
  t."expires_at",
  t."ip",
  t."created_at"
FROM "auth_tokens" t
JOIN "users" u ON u."id" = t."user_id"
WHERE t."purpose" = 'ACCOUNT_CLAIM'
  AND t."consumed_at" IS NULL
  AND u."password_hash" IS NULL
  AND u."email" IS NOT NULL
  AND u."is_deactivated" = false
  AND NOT EXISTS (
    SELECT 1 FROM "pending_invitations" p WHERE p."token_hash" = t."token_hash"
  );
