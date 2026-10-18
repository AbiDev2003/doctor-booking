import type { PaymentOrder } from "./api";

/**
 * Day 23 — the browser half of §17: Razorpay's hosted checkout.
 *
 * checkout.js is loaded lazily from Razorpay's CDN on the FIRST "Pay online"
 * tap, so the storefront's normal page loads pay nothing for a payment provider
 * nobody has asked yet. The module holds at most one loader promise; a failed
 * load clears it so the next tap retries.
 *
 * The window itself is honest about Day 23's scope: an opened checkout proves
 * an order exists (the server's DoD), and NOTHING is trusted from what comes
 * back here — `handler`'s `order_id/payment_id/signature` triple is verified
 * server-side on Day 24 (§17 step 3), and the appointment is born there too
 * (§17 step 5). Until then a completed payment can only be described as
 * "received, verification pending", never as "booked".
 */

/** What an opened checkout resolves to: the patient finished, or backed out. */
export type CheckoutOutcome = "paid" | "dismissed";

/**
 * The triple Razorpay hands the browser after a successful payment. Named and
 * typed now so Day 24's verify step has one vocabulary for it; today's handler
 * deliberately ignores the contents.
 */
export interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** The subset of checkout.js options this app uses — nothing speculative. */
interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  name?: string;
  handler?: (response: CheckoutSuccess) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/** The single in-flight load, shared by every tap on the page. */
let checkoutScript: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (!checkoutScript) {
    checkoutScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = CHECKOUT_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Cleared so a transient failure does not poison every future tap.
        checkoutScript = null;
        reject(new Error("The payment window failed to load. Check your connection and try again."));
      };
      document.body.appendChild(script);
    });
  }
  return checkoutScript;
}

/**
 * Opens checkout for an order and settles when the window closes —
 * `"paid"` when the patient completed the gateway flow, `"dismissed"` when
 * they backed out (charged or not, this layer cannot and must not decide;
 * Day 24's verification is the only authority on that).
 *
 * `handler` and `modal.ondismiss` may BOTH fire as the modal closes on some
 * paths, so the promise settles exactly once.
 */
export async function openRazorpayCheckout(
  order: PaymentOrder,
  options: { merchantName?: string } = {},
): Promise<CheckoutOutcome> {
  await loadCheckoutScript();

  const Checkout = window.Razorpay;
  if (!Checkout) {
    throw new Error("The payment window failed to load. Try again.");
  }

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: CheckoutOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const checkout = new Checkout({
      key: order.keyId,
      order_id: order.orderId,
      ...(options.merchantName !== undefined && { name: options.merchantName }),
      handler: () => settle("paid"),
      modal: { ondismiss: () => settle("dismissed") },
    });
    checkout.open();
  });
}
