import Razorpay from "razorpay";

/**
 * plan.md §17 — the payment-provider seam (Day 23).
 *
 * §17 asks for a payment layer "abstracted enough that another provider could
 * theoretically be introduced later", and this file is that layer in its
 * smallest honest form: a two-method-worth interface, one Razorpay factory,
 * and the two pure helpers the tests can pin without a network or a key.
 *
 * Nothing here reads `config.ts` — the caller (paymentOrder.service.ts) owns
 * the environment decision, so this module stays importable by `npm test`
 * with no `.env` at all, exactly like `lib/fee.ts`.
 */

/** What the service asks the gateway to create — money as integer subunits. */
export interface GatewayOrderParams {
  /** Paise (§3.2). Never a float, never a rupee figure: the gateway takes subunits. */
  readonly amountPaise: number;
  readonly currency: string;
  /** Local correlation id — the `Payment.id` the order is being created for. */
  readonly receipt: string;
}

/** A created gateway order, normalised back into our own vocabulary. */
export interface GatewayOrder {
  readonly orderId: string;
  readonly amountPaise: number;
  readonly currency: string;
  /**
   * The PUBLISHABLE key the browser's checkout needs to open. The secret key
   * has no path to this type — it goes into the factory and never comes out.
   */
  readonly keyId: string;
}

/**
 * The seam itself. Day 24's verify/conversion tests inject a fake implementing
 * this interface; production wires `createRazorpayGateway`.
 */
export interface PaymentGateway {
  createOrder(params: GatewayOrderParams): Promise<GatewayOrder>;
}

/**
 * The §3.2 money rule applied to an order request: subunits pass through
 * untouched and the receipt is the local payment row, so every gateway order
 * can be traced to exactly one `Payment` (the §17 idempotency key's partner).
 *
 * Razorpay caps `receipt` at 40 characters; a uuid(7) is 36, which is why the
 * id format and this constraint fit without a surrogate.
 */
export function toGatewayOrderParams(input: {
  readonly paymentId: string;
  readonly amountPaise: number;
  readonly currency: string;
}): GatewayOrderParams {
  return {
    amountPaise: input.amountPaise,
    currency: input.currency,
    receipt: input.paymentId,
  };
}

/**
 * Builds the Razorpay-backed gateway.
 *
 * The echo check inside `createOrder` is §17 step 4's spirit applied at
 * creation time: an order that answers back with a different amount or
 * currency than was asked for is a broken channel, and a broken channel must
 * never reach the `Payment` row — the caller sees a plain error and takes the
 * `FAILED` path.
 *
 * `keyId` is returned with every order because the browser needs the publishable
 * key to open checkout; shipping it in the order response is what keeps the
 * client free of any Razorpay env var of its own.
 */
export function createRazorpayGateway(keyId: string, keySecret: string): PaymentGateway {
  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  return {
    async createOrder(params: GatewayOrderParams): Promise<GatewayOrder> {
      const order = await razorpay.orders.create({
        amount: params.amountPaise,
        currency: params.currency,
        receipt: params.receipt,
      });

      const amountPaise = Number(order.amount);
      if (!Number.isInteger(amountPaise) || amountPaise !== params.amountPaise || order.currency !== params.currency) {
        throw new Error(
          `Razorpay order echo mismatch: asked ${params.amountPaise} ${params.currency}, got ${String(order.amount)} ${order.currency}`,
        );
      }

      return { orderId: order.id, amountPaise, currency: order.currency, keyId };
    },
  };
}
