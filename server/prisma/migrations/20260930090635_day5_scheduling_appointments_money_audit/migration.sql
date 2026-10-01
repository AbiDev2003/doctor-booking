/*
  Warnings:

  - You are about to drop the column `full_name` on the `patient_profiles` table. All the data in the column will be lost.
  - Added the required column `full_name` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "auth_attempt_purpose" AS ENUM ('LOGIN', 'OTP_SEND', 'OTP_VERIFY');

-- CreateEnum
CREATE TYPE "weekday" AS ENUM ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('CONFIRMED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW', 'PENDING');

-- CreateEnum
CREATE TYPE "appointment_event_type" AS ENUM ('BOOKED', 'PAID', 'RESCHEDULED', 'CANCELLED', 'REJECTED', 'ARRIVED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "seat_hold_release_reason" AS ENUM ('EXPIRED', 'ABANDONED', 'PAYMENT_FAILED', 'CONVERTED', 'DELETED_WITH_ACCOUNT');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PAID', 'FAILED', 'VOIDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD', 'UPI');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "refund_kind" AS ENUM ('RESCHEDULE_DELTA', 'CANCELLATION', 'CLINIC_CAUSED', 'EXPIRED_HOLD', 'CONVERSION_FAILED', 'DESK_HAND_BACK');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('ACCOUNT_EMAIL_VERIFICATION', 'ACCOUNT_INVITATION', 'ACCOUNT_EMAIL_CHANGE_VERIFICATION', 'ACCOUNT_PASSWORD_RESET_REQUESTED', 'ACCOUNT_PASSWORD_RESET_COMPLETED', 'ACCOUNT_ALL_SESSIONS_REVOKED', 'ACCOUNT_DEACTIVATED', 'DOCTOR_VERIFIED', 'DOCTOR_SUSPENDED_OR_ARCHIVED', 'DOCTOR_STAFF_ACTION', 'APPOINTMENT_BOOKED', 'APPOINTMENT_REJECTED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_RESCHEDULED', 'DOCTOR_UNAVAILABLE', 'APPOINTMENT_AUTO_CANCELLED', 'PAYMENT_SUCCESSFUL', 'PAYMENT_FAILED', 'PAYMENT_LATE_REFUND', 'REFUND_COMPLETED', 'REFUND_REQUESTED', 'REFUND_REJECTED', 'REMINDER');

-- AlterTable
ALTER TABLE "patient_profiles" DROP COLUMN "full_name";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "full_name" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "weekday" "weekday" NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "max_patients" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "slot_date" DATE NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "max_patients" INTEGER NOT NULL,
    "booked_count" INTEGER NOT NULL DEFAULT 0,
    "held_count" INTEGER NOT NULL DEFAULT 0,
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "disabled_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_unavailabilities" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_unavailabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'CONFIRMED',
    "doctor_name" TEXT NOT NULL,
    "fee_amount" INTEGER NOT NULL,
    "booking_time" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doctor_unavailability_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_holds" (
    "id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "payment_order_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" "seat_hold_release_reason",

    CONSTRAINT "seat_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "appointment_id" UUID,
    "patient_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "method" "payment_method",
    "order_id" TEXT,
    "payment_id" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "collected_by_id" UUID,
    "collected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "kind" "refund_kind" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "method" "payment_method",
    "actor_id" UUID,
    "actor_role" "user_role",
    "actor_name" TEXT NOT NULL,
    "gateway_refund_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_histories" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "event_type" "appointment_event_type" NOT NULL,
    "from_status" "appointment_status",
    "to_status" "appointment_status",
    "metadata" JSONB,
    "actor_id" UUID,
    "actor_role" "user_role",
    "actor_name" TEXT NOT NULL,
    "reason" TEXT,
    "ip" INET,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_histories" (
    "id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB,
    "actor_id" UUID,
    "actor_role" "user_role",
    "actor_name" TEXT NOT NULL,
    "reason" TEXT,
    "ip" INET,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_id" UUID,
    "actor_role" "user_role",
    "actor_name" TEXT NOT NULL,
    "reason" TEXT,
    "ip" INET,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT NOT NULL,
    "appointment_id" UUID,
    "slot_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "identifier_key" TEXT NOT NULL,
    "ip_key" TEXT NOT NULL,
    "purpose" "auth_attempt_purpose" NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedules_doctor_id_weekday_start_time_key" ON "schedules"("doctor_id", "weekday", "start_time");

-- CreateIndex
CREATE INDEX "slots_doctor_id_start_at_idx" ON "slots"("doctor_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "slots_doctor_id_slot_date_start_time_key" ON "slots"("doctor_id", "slot_date", "start_time");

-- CreateIndex
CREATE INDEX "doctor_unavailabilities_doctor_id_start_at_idx" ON "doctor_unavailabilities"("doctor_id", "start_at");

-- CreateIndex
CREATE INDEX "appointments_slot_id_booking_time_idx" ON "appointments"("slot_id", "booking_time");

-- CreateIndex
CREATE INDEX "appointments_doctor_unavailability_id_idx" ON "appointments"("doctor_unavailability_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "refunds_status_kind_idx" ON "refunds"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_payment_id_kind_key" ON "refunds"("payment_id", "kind");

-- CreateIndex
CREATE INDEX "appointment_histories_appointment_id_created_at_idx" ON "appointment_histories"("appointment_id", "created_at");

-- CreateIndex
CREATE INDEX "doctor_histories_doctor_id_created_at_idx" ON "doctor_histories"("doctor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_created_at_idx" ON "audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_created_at_idx" ON "notifications"("recipient", "created_at");

-- CreateIndex
CREATE INDEX "auth_attempts_identifier_key_purpose_created_at_idx" ON "auth_attempts"("identifier_key", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "auth_attempts_ip_key_created_at_idx" ON "auth_attempts"("ip_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_unavailabilities" ADD CONSTRAINT "doctor_unavailabilities_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_unavailabilities" ADD CONSTRAINT "doctor_unavailabilities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_unavailability_id_fkey" FOREIGN KEY ("doctor_unavailability_id") REFERENCES "doctor_unavailabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_histories" ADD CONSTRAINT "appointment_histories_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_histories" ADD CONSTRAINT "appointment_histories_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_histories" ADD CONSTRAINT "doctor_histories_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_histories" ADD CONSTRAINT "doctor_histories_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
