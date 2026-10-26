import type { EmailContent } from "./mailer.js";

/**
 * plan.md §18 — the auth/account transactional templates.
 *
 * Plain functions returning `{ subject, html, text }` rather than a templating
 * engine: the content is static English with a handful of escaped values, and a
 * template runtime would be more moving parts than the whole set of emails.
 */

const DEFAULT_BRAND = "Doctor Booking";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function greeting(fullName: string): string {
  const name = fullName.trim();
  return name.length > 0 ? `Hi ${name},` : "Hi,";
}

function layout(brand: string, heading: string, bodyHtml: string, footerHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px;">
            <tr><td style="font-size:18px;font-weight:700;padding-bottom:24px;">${escapeHtml(brand)}</td></tr>
            <tr><td style="font-size:22px;font-weight:700;padding-bottom:16px;">${escapeHtml(heading)}</td></tr>
            <tr><td style="font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
            <tr><td style="font-size:12px;line-height:1.6;color:#7b8794;padding-top:32px;">${footerHtml}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(link: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(link)}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;">${escapeHtml(label)}</a></p>`;
}

function text(fullName: string, lines: readonly string[], brand: string): string {
  return [greeting(fullName), "", ...lines, "", `— ${brand}`].join("\n");
}

interface BaseTemplateInput {
  readonly fullName: string;
  readonly brand?: string;
}

export interface LinkTemplateInput extends BaseTemplateInput {
  readonly link: string;
  readonly expiresIn: string;
}

export function emailVerificationEmail(input: LinkTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `Verify your email address for ${brand}`,
    html: layout(
      brand,
      "Verify your email address",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Confirm this address to finish setting up your account. This link expires in ${escapeHtml(input.expiresIn)}.</p>
       ${button(input.link, "Verify email")}
       <p>If you did not create this account, you can ignore this email.</p>`,
      "If the button does not work, copy and paste the link from this email into your browser.",
    ),
    text: text(
      input.fullName,
      [
        `Confirm this address to finish setting up your account. This link expires in ${input.expiresIn}:`,
        input.link,
        "",
        "If you did not create this account, you can ignore this email.",
      ],
      brand,
    ),
  };
}

export interface InvitationTemplateInput extends LinkTemplateInput {
  readonly roleLabel: string;
}

export function accountInvitationEmail(input: InvitationTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `You are invited to ${brand}`,
    html: layout(
      brand,
      "You are invited",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>An account has been created for you as a ${escapeHtml(input.roleLabel)}. Set your password to activate it. This invitation expires in ${escapeHtml(input.expiresIn)}.</p>
       ${button(input.link, "Accept invitation")}`,
      "If you were not expecting this invitation, you can ignore this email.",
    ),
    text: text(
      input.fullName,
      [
        `An account has been created for you as a ${input.roleLabel}. Set your password to activate it. This invitation expires in ${input.expiresIn}:`,
        input.link,
        "",
        "If you were not expecting this invitation, you can ignore this email.",
      ],
      brand,
    ),
  };
}

export function emailChangeVerificationEmail(input: LinkTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `Confirm your new email address for ${brand}`,
    html: layout(
      brand,
      "Confirm your new email address",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Use the link below to make this your account email. Your current address stays active until then. This link expires in ${escapeHtml(input.expiresIn)}.</p>
       ${button(input.link, "Confirm new email")}
       <p>If you did not request this change, no action is needed and your address will stay the same.</p>`,
      "Your current email address continues to work until the new one is confirmed.",
    ),
    text: text(
      input.fullName,
      [
        `Use the link below to make this your account email. Your current address stays active until then. This link expires in ${input.expiresIn}:`,
        input.link,
        "",
        "If you did not request this change, no action is needed and your address will stay the same.",
      ],
      brand,
    ),
  };
}

export interface PasswordResetTemplateInput extends BaseTemplateInput {
  readonly method: "LINK" | "OTP";
  readonly link?: string | undefined;
  readonly otp?: string | undefined;
  readonly expiresIn: string;
}

export function passwordResetEmail(input: PasswordResetTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;

  const actionHtml =
    input.method === "OTP"
      ? `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0;">${escapeHtml(input.otp ?? "")}</p>`
      : button(input.link ?? "", "Reset password");

  const actionText =
    input.method === "OTP"
      ? [`Your reset code is: ${input.otp ?? ""}`]
      : [`Reset your password here:`, input.link ?? ""];

  return {
    subject: `Reset your ${brand} password`,
    html: layout(
      brand,
      "Reset your password",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>We received a request to reset your password. It expires in ${escapeHtml(input.expiresIn)}.</p>
       ${actionHtml}
       <p>If you did not request a reset, you can ignore this email — your password has not changed.</p>`,
      "For your security, do not share this link or code with anyone.",
    ),
    text: text(
      input.fullName,
      [
        `We received a request to reset your password. It expires in ${input.expiresIn}.`,
        ...actionText,
        "",
        "If you did not request a reset, you can ignore this email — your password has not changed.",
      ],
      brand,
    ),
  };
}

export function passwordResetCompletedEmail(input: BaseTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `Your ${brand} password was changed`,
    html: layout(
      brand,
      "Your password was changed",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your password was reset and every signed-in session was ended. You can sign in again with your new password.</p>
       <p>If this was not you, reset your password again immediately.</p>`,
      "This is a security notice about your account.",
    ),
    text: text(
      input.fullName,
      [
        "Your password was reset and every signed-in session was ended. You can sign in again with your new password.",
        "",
        "If this was not you, reset your password again immediately.",
      ],
      brand,
    ),
  };
}

export function allSessionsRevokedEmail(input: BaseTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `Security notice: all ${brand} sessions were signed out`,
    html: layout(
      brand,
      "All sessions were signed out",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>An administrator signed out every device on your account. You will need to sign in again.</p>
       <p>If you did not expect this, contact the clinic administrator.</p>`,
      "This is a security notice about your account.",
    ),
    text: text(
      input.fullName,
      [
        "An administrator signed out every device on your account. You will need to sign in again.",
        "",
        "If you did not expect this, contact the clinic administrator.",
      ],
      brand,
    ),
  };
}

export function accountDeactivatedEmail(input: BaseTemplateInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  return {
    subject: `Your ${brand} account was deleted`,
    html: layout(
      brand,
      "Your account was deleted",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your account has been deactivated and your personal details have been anonymised. You will not receive further appointment emails from us.</p>`,
      "If you did not request this, contact the clinic as soon as possible.",
    ),
    text: text(
      input.fullName,
      [
        "Your account has been deactivated and your personal details have been anonymised. You will not receive further appointment emails from us.",
        "",
        "If you did not request this, contact the clinic as soon as possible.",
      ],
      brand,
    ),
  };
}
