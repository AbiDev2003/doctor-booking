/*
  Warnings:

  - You are about to drop the `Placeholder` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('PATIENT', 'DOCTOR', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "doctor_verification_status" AS ENUM ('INVITED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "auth_token_purpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'ACCOUNT_CLAIM', 'EMAIL_CHANGE');

-- DropTable
DROP TABLE "Placeholder";

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "default_consultation_fee" INTEGER NOT NULL,
    "booking_horizon_days" INTEGER NOT NULL DEFAULT 60,
    "cancel_cutoff_minutes" INTEGER NOT NULL DEFAULT 60,
    "hold_duration_minutes" INTEGER NOT NULL DEFAULT 10,
    "min_lead_minutes" INTEGER NOT NULL DEFAULT 0,
    "reminder_lead_minutes" INTEGER NOT NULL DEFAULT 120,
    "max_active_bookings_per_patient" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "role" "user_role" NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "pending_email" TEXT,
    "is_deactivated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "verification_status" "doctor_verification_status" NOT NULL DEFAULT 'INVITED',
    "suspended_at" TIMESTAMPTZ(3),
    "suspend_reason" TEXT,
    "qualification" TEXT,
    "license_number" TEXT,
    "experience" TEXT,
    "clinic_association" TEXT,
    "specialization" TEXT,
    "consultation_fee" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "auth_token_purpose" NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "ip" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "patient_profiles_user_id_key" ON "patient_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_profiles_phone_key" ON "patient_profiles"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_user_id_key" ON "doctor_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- AddForeignKey
ALTER TABLE "patient_profiles" ADD CONSTRAINT "patient_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
