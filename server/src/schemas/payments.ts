import { z } from "zod";

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
