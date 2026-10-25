import type { PaymentOrder } from "./api";

/**
 * Days 23–24 — the browser half of §17: Razorpay's hosted checkout.
 *
 * checkout.js is loaded lazily from Razorpay's CDN on the FIRST "Pay online"
 * tap, so the storefront's normal page loads pay nothing for a payment provider
 * nobody has asked yet. The module holds at most one loader promise; a failed
 * load clears it so the next tap retries.
 *
 * This layer is a MESSENGER and knows it: it opens the window and hands back
 * either the gateway's `order_id/payment_id/signature` triple (→ the page
 * POSTs it to /payments/verify) or `"dismissed"`. It never claims a payment
 * succeeded — only the server's signature recomputation does (§17 step 3) —
 * and it never claims a booking: the appointment is born in the verify
 * transaction, not here.
 */

/**
 * What an opened checkout settles to: the gateway's success triple, or the
 * patient backing out. `"dismissed"` is not a verdict on money — the gateway
 * may not even have attempted anything — which is exactly why it is the only
 * outcome this module names itself.
 */
export type CheckoutResult = CheckoutSuccess | "dismissed";

/**
 * The triple Razorpay hands the browser after a successful payment, in the
 * gateway's own field names (the server schema mirrors them verbatim). Passed
 * through untouched: every field is worthless until the server recomputes the
 * signature over it.
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
 * Opens checkout for an order and settles when the window closes — the
 * gateway's success triple when the patient completed the flow, `"dismissed"`
 * when they backed out. Verification is the CALLER's next step (§17 step 3),
 * deliberately outside this module: a closing window says nothing about money.
 *
 * `handler` and `modal.ondismiss` may BOTH fire as the modal closes on some
 * paths, so the promise settles exactly once (first outcome wins — the handler
 * always runs before the dismiss callback on Razorpay's success path).
 */
export async function openRazorpayCheckout(
  order: PaymentOrder,
  options: { merchantName?: string } = {},
): Promise<CheckoutResult> {
  await loadCheckoutScript();

  const Checkout = window.Razorpay;
  if (!Checkout) {
    throw new Error("The payment window failed to load. Try again.");
  }

  return new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    const settle = (outcome: CheckoutResult): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const checkout = new Checkout({
      key: order.keyId,
      order_id: order.orderId,
      ...(options.merchantName !== undefined && { name: options.merchantName }),
      handler: (response) => settle(response),
      modal: { ondismiss: () => settle("dismissed") },
    });
    checkout.open();
  });
}
