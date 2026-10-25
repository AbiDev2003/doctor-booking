import { z } from "zod";
import { $Enums } from "../generated/prisma/client.js";

/**
 * Day 23 request shapes — §17's online-payment surface.
 *
 * Same rule as Day 19's booking body (`schemas/appointments.ts`): the client
 * sends a slot id and NOTHING else. No amount, no currency, no patientId — the
 * server derives all three, so a caller cannot name its own price (§3.4).
 * A future reschedule top-up (§14's `PAYMENT_REQUIRED`, Day 24) gets its own
 * shape here rather than growing this one.
 */
export const createPaymentOrderSchema = z.object({
  slotId: z.uuid("Invalid slot id"),
});

export type CreatePaymentOrderShape = z.infer<typeof createPaymentOrderSchema>;

/**
 * The order the browser's checkout opens with (server twin of the client's
 * `PaymentOrder` in `lib/api.ts`).
 *
 * `keyId` is deliberately public — it is Razorpay's publishable key, the one
 * value checkout.js needs to identify the merchant, and it is why the client
 * carries no Razorpay env var of its own. The secret key never appears in any
 * DTO. `amountPaise` is integer subunits (§3.2/§24): paise in, paise out,
 * no float ever crosses the API edge.
 */
export interface PaymentOrderDto {
  readonly orderId: string;
  readonly keyId: string;
  readonly amountPaise: number;
  readonly currency: string;
}

/**
 * Day 24 — what the browser posts after checkout hands it the triple (§17
 * step 3). Field names are the gateway's own (razorpay_*), kept verbatim: this
 * body is a pass-through of values the customer's payment window produced, and
 * renaming them would only create a second vocabulary for one fact. Nothing
 * here is trusted — the signature is recomputed server-side from the order id
 * and payment id (lib/paymentSignature.ts), and the amount is never among the
 * inputs; the money was frozen when the order was created (Day 23).
 */
export const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(1, "Missing order id"),
  razorpay_payment_id: z.string().min(1, "Missing payment id"),
  razorpay_signature: z.string().min(1, "Missing payment signature"),
});

export type VerifyPaymentShape = z.infer<typeof verifyPaymentSchema>;

/**
 * Day 26 — the pay-at-clinic desk surface (§17).
 *
 * Collection is keyed by appointment, not payment id: the desk starts from the
 * patient in front of it. `amountPaise` is optional so the normal path collects
 * the fee snapshot; when supplied it is the ACTUAL cash/UPI amount (a concession
 * may collect less), and the service rejects anything above the outstanding fee.
 * The method is the desk's report of what it took, never inferred.
 */
export const collectOfflinePaymentSchema = z.object({
  appointmentId: z.uuid("Invalid appointment id"),
  method: z.enum([$Enums.PaymentMethod.CASH, $Enums.PaymentMethod.CARD, $Enums.PaymentMethod.UPI]),
  amountPaise: z.number().int().positive("Amount must be a positive number of paise").optional(),
});

export type CollectOfflinePaymentShape = z.infer<typeof collectOfflinePaymentSchema>;

/** Voiding an unpaid receivable needs a reason because it writes an audit row. */
export const voidOfflinePaymentSchema = z.object({
  appointmentId: z.uuid("Invalid appointment id"),
  reason: z.string().trim().min(1, "A reason is required").max(1000),
});

export type VoidOfflinePaymentShape = z.infer<typeof voidOfflinePaymentSchema>;

/**
 * A hand-back is CASH or UPI only (§17): CARD is collection vocabulary, and no
 * gateway is involved. The amount is the queued refund's own amount — never a
 * request field, so a hand-back cannot pay out more or less than was queued.
 */
export const completeHandBackSchema = z.object({
  method: z.enum([$Enums.PaymentMethod.CASH, $Enums.PaymentMethod.UPI]),
});

export type CompleteHandBackShape = z.infer<typeof completeHandBackSchema>;

export const refundIdParamSchema = z.object({
  id: z.uuid("Invalid refund id"),
});

/** What collection/void returns; the desk never needs gateway ids for offline money. */
export interface OfflinePaymentDto {
  readonly paymentId: string;
  readonly appointmentId: string;
  readonly patientId: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: $Enums.PaymentStatus;
  readonly method: $Enums.PaymentMethod | null;
  readonly paidAt: string | null;
  readonly collectedById: string | null;
  readonly collectedAt: string | null;
}

/** One row in the staff desk hand-back queue. */
export interface DeskHandBackDto {
  readonly refundId: string;
  readonly paymentId: string;
  readonly appointmentId: string | null;
  readonly patientId: string;
  readonly patientName: string;
  readonly amountPaise: number;
  readonly kind: $Enums.RefundKind;
  readonly reason: string;
  readonly createdAt: string;
}
