import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * plan.md §18 — the one delivery seam for transactional email.
 *
 * A notification is a database row first (`Notification`) and an email second.
 * Keeping the provider behind this interface is what lets the DoD run key-free
 * with a fake, and what stops a Resend outage from being reachable from the
 * request path: the caller only writes a row, and the send is dispatched later.
 */

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailMessage extends EmailContent {
  readonly to: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ readonly id: string }>;
}

/** Turn the raw provider response into a short, human-readable failure. */
async function providerError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = body.trim().length > 0 ? `: ${body.trim().slice(0, 500)}` : "";
  return new Error(`Resend responded ${response.status}${detail}`);
}

export class ResendMailer implements Mailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo: string | undefined;

  constructor(apiKey: string, from: string, fromName: string, replyTo: string | undefined) {
    this.apiKey = apiKey;
    this.from = fromName.length > 0 ? `${fromName} <${from}>` : from;
    this.replyTo = replyTo;
  }

  async send(message: MailMessage): Promise<{ readonly id: string }> {
    // Resend's REST API rather than its SDK: one small POST is the whole
    // contract, and an SDK dependency would be a supply-chain surface for no
    // behaviour we do not already write here.
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(this.replyTo !== undefined && { reply_to: this.replyTo }),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw await providerError(response);
    }

    // A 2xx means Resend accepted the message; the response id is useful but
    // not worth turning an accepted send into a FAILED row if the body is odd.
    const body = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { id: typeof body.id === "string" ? body.id : "resend-accepted" };
  }
}

/**
 * Development/test transport. It logs the rendered text — links and OTPs
 * included — which is exactly why it is unreachable in production: the boot
 * config requires `RESEND_API_KEY` there, and the constructor below refuses
 * anyway rather than trusting only one guard.
 */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<{ readonly id: string }> {
    if (config.NODE_ENV === "production") {
      throw new Error("ConsoleMailer must not be used in production");
    }

    logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      "email (console transport — development only)",
    );

    return { id: `console_${randomUUID()}` };
  }
}

export function createMailer(): Mailer {
  if (config.RESEND_API_KEY !== undefined) {
    return new ResendMailer(config.RESEND_API_KEY, config.EMAIL_FROM, config.EMAIL_FROM_NAME, config.EMAIL_REPLY_TO);
  }

  if (config.NODE_ENV === "production") {
    throw new Error("RESEND_API_KEY is required in production");
  }

  logger.warn("RESEND_API_KEY is not set — email will be written to the log instead of sent");
  return new ConsoleMailer();
}

let singleton: Mailer | undefined;

/** The process-wide mailer. Tests and DoD scripts inject their own instead. */
export function getMailer(): Mailer {
  singleton ??= createMailer();
  return singleton;
}
