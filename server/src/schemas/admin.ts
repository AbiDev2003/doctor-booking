import { z } from "zod";
import type { $Enums } from "../generated/prisma/client.js";
import type { AppointmentDto } from "./appointments.js";

/**
 * plan.md §29 — the admin dashboard's request and response shapes (Day 33).
 * Day 33 is a read surface plus the UI over mutations that already exist. The
 * queries therefore stay deliberately small and index-friendly: one optional
 * text search, equality filters the schema already indexes, and a hard limit.
 * No offset pagination and no export — §42 keeps both out of MVP, and the audit
 * feed is the one list that needs a cursor (Day 20 already built it).
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD, e.g. 2026-10-09");
const limit = z.coerce.number().int().min(1).max(100).default(50);

export const adminPatientsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit,
});

export type AdminPatientsQueryShape = z.infer<typeof adminPatientsQuerySchema>;

export const adminAppointmentsQuerySchema = z.object({
  date: date.optional(),
  status: z.enum(["CONFIRMED", "ARRIVED", "COMPLETED", "CANCELLED", "REJECTED", "NO_SHOW", "PENDING"]).optional(),
  doctorId: z.uuid("Invalid doctor id").optional(),
  limit,
});

export type AdminAppointmentsQueryShape = z.infer<typeof adminAppointmentsQuerySchema>;

export const adminPaymentsQuerySchema = z.object({
  status: z.enum(["PENDING", "PAID", "FAILED", "VOIDED"]).optional(),
  method: z.enum(["CASH", "CARD", "UPI"]).optional(),
  limit,
});

export type AdminPaymentsQueryShape = z.infer<typeof adminPaymentsQuerySchema>;

export const adminRefundsQuerySchema = z.object({
  status: z.enum(["PENDING", "SUCCESS", "FAILED"]).default("FAILED"),
  limit,
});

export type AdminRefundsQueryShape = z.infer<typeof adminRefundsQuerySchema>;

export const adminNotificationsQuerySchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED"]).optional(),
  type: z.string().trim().min(1).max(64).optional(),
  limit,
});

export type AdminNotificationsQueryShape = z.infer<typeof adminNotificationsQuerySchema>;

/** Today's counts, money and the two failure queues that need a human (§18/§17). */
export interface AdminOverviewDto {
  readonly date: string;
  readonly currency: string;
  readonly appointments: {
    readonly total: number;
    readonly confirmed: number;
    readonly arrived: number;
    readonly completed: number;
    readonly cancelled: number;
    readonly rejected: number;
    readonly noShow: number;
  };
  readonly money: {
    readonly collectedPaise: number;
    readonly outstandingPaise: number;
  };
  readonly doctors: {
    readonly verified: number;
    readonly pendingVerification: number;
    readonly suspended: number;
    readonly archived: number;
  };
  readonly patients: {
    readonly total: number;
    readonly provisional: number;
  };
  readonly refunds: {
    readonly failed: number;
    readonly pending: number;
  };
  readonly notifications: {
    readonly failed: number;
    readonly pending: number;
  };
}

/** One patient row in the admin roster. */
export interface AdminPatientDto {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly isProvisional: boolean;
  readonly isDeactivated: boolean;
  readonly createdAt: string;
  readonly completedCount: number;
  readonly noShowCount: number;
  readonly upcomingCount: number;
  readonly lastVisitDate: string | null;
  readonly returning: boolean;
}

export interface AdminPatientsDto {
  readonly patients: readonly AdminPatientDto[];
}

/** One payment row in the clinic-wide money list. */
export interface AdminPaymentRefundDto {
  readonly id: string;
  readonly kind: $Enums.RefundKind;
  readonly amountPaise: number;
  readonly status: $Enums.RefundStatus;
  readonly method: $Enums.PaymentMethod | null;
  readonly reason: string;
  readonly createdAt: string;
}

export interface AdminPaymentDto {
  readonly id: string;
  readonly appointmentId: string | null;
  readonly patientId: string;
  readonly patientName: string;
  readonly patientPhone: string;
  readonly doctorName: string | null;
  readonly slotDate: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: $Enums.PaymentStatus;
  readonly method: $Enums.PaymentMethod | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly collectedByName: string | null;
  readonly refunds: readonly AdminPaymentRefundDto[];
}

export interface AdminPaymentsDto {
  readonly payments: readonly AdminPaymentDto[];
}

/** A refund that needs an admin decision (a failed gateway refund). */
export interface AdminRefundDto {
  readonly id: string;
  readonly paymentId: string;
  readonly appointmentId: string | null;
  readonly patientId: string;
  readonly patientName: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly kind: $Enums.RefundKind;
  readonly status: $Enums.RefundStatus;
  readonly method: $Enums.PaymentMethod | null;
  readonly reason: string;
  readonly gatewayRefundId: string | null;
  readonly actorName: string;
  readonly createdAt: string;
}

export interface AdminRefundsDto {
  readonly refunds: readonly AdminRefundDto[];
}

export interface AdminNotificationDto {
  readonly id: string;
  readonly type: $Enums.NotificationType;
  readonly status: $Enums.NotificationStatus;
  readonly recipient: string;
  readonly appointmentId: string | null;
  readonly error: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface AdminNotificationsDto {
  readonly notifications: readonly AdminNotificationDto[];
}

/** An appointment row with the patient and money summary the admin needs. */
export interface AdminAppointmentDto extends AppointmentDto {
  readonly patientName: string;
  readonly patientPhone: string;
  readonly patientEmail: string | null;
  readonly isProvisional: boolean;
  readonly payment: {
    readonly status: "PENDING" | "PAID" | "NONE";
    readonly outstandingPaise: number;
    readonly paidPaise: number;
    readonly method: $Enums.PaymentMethod | null;
  };
}

export interface AdminAppointmentsDto {
  readonly appointments: readonly AdminAppointmentDto[];
}
