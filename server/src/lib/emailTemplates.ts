import type { EmailContent } from "./mailer.js";

/**
 * plan.md §18 — the auth/account transactional templates.
 *
 * Plain functions returning `{ subject, html, text }` rather than a templating
 * engine: the content is static English with a handful of escaped values, and a
 * template runtime would be more moving parts than the whole set of emails.
 */

const DEFAULT_BRAND = "City Care Clinic";

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

export interface AppointmentEmailInput extends BaseTemplateInput {
  readonly appointmentId: string;
  readonly doctorName?: string;
  readonly slotDate?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly amountPaise?: number;
  readonly reason?: string;
}

function formatAmount(amountPaise?: number): string | undefined {
  if (amountPaise === undefined || amountPaise === null) return undefined;
  const rupees = amountPaise / 100;
  return `₹${rupees.toFixed(2)}`;
}

export function appointmentBookedEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  else if (input.startTime) details.push(`Time: ${input.startTime}`);
  if (input.amountPaise !== undefined && input.amountPaise !== null) {
    const amt = formatAmount(input.amountPaise);
    if (amt) details.push(`Fee: ${amt}`);
  }
  details.push(`Appointment ID: ${input.appointmentId}`);

  return {
    subject: `Booking confirmation - ${brand}`,
    html: layout(
      brand,
      "Booking confirmed",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment has been confirmed.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "We look forward to seeing you.",
    ),
    text: text(input.fullName, ["Your appointment has been confirmed.", "", ...details], brand),
  };
}

export function appointmentCancelledEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.reason) details.push(`Reason: ${input.reason}`);

  return {
    subject: `Appointment cancelled - ${brand}`,
    html: layout(
      brand,
      "Appointment cancelled",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment has been cancelled.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "If you have questions, please contact the clinic.",
    ),
    text: text(input.fullName, ["Your appointment has been cancelled.", "", ...details], brand),
  };
}

export function appointmentRescheduledEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`New date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`New time: ${input.startTime} - ${input.endTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.amountPaise !== undefined && input.amountPaise !== null) {
    const amt = formatAmount(input.amountPaise);
    if (amt) details.push(`Fee: ${amt}`);
  }

  return {
    subject: `Appointment rescheduled - ${brand}`,
    html: layout(
      brand,
      "Appointment rescheduled",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment has been rescheduled.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "Please arrive on time for your new slot.",
    ),
    text: text(input.fullName, ["Your appointment has been rescheduled.", "", ...details], brand),
  };
}

export function appointmentRejectedEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.reason) details.push(`Reason: ${input.reason}`);

  return {
    subject: `Appointment rejected - ${brand}`,
    html: layout(
      brand,
      "Appointment rejected",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment request has been rejected.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "If you have questions, please contact the clinic.",
    ),
    text: text(input.fullName, ["Your appointment request has been rejected.", "", ...details], brand),
  };
}

export function doctorUnavailableEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.reason) details.push(`Reason: ${input.reason}`);

  return {
    subject: `Doctor unavailable - ${brand}`,
    html: layout(
      brand,
      "Doctor unavailable",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your doctor is unavailable for this appointment.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "We will help you reschedule or cancel as needed.",
    ),
    text: text(input.fullName, ["Your doctor is unavailable for this appointment.", "", ...details], brand),
  };
}

export function appointmentAutoCancelledEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.reason) details.push(`Reason: ${input.reason}`);

  return {
    subject: `Appointment auto-cancelled - ${brand}`,
    html: layout(
      brand,
      "Appointment auto-cancelled",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment has been automatically cancelled.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "If you have questions, please contact the clinic.",
    ),
    text: text(input.fullName, ["Your appointment has been automatically cancelled.", "", ...details], brand),
  };
}

export function paymentReceiptEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  if (input.amountPaise !== undefined && input.amountPaise !== null) {
    const amt = formatAmount(input.amountPaise);
    if (amt) details.push(`Amount paid: ${amt}`);
  }
  details.push(`Appointment ID: ${input.appointmentId}`);

  return {
    subject: `Payment receipt - ${brand}`,
    html: layout(
      brand,
      "Payment received",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Thank you for your payment. Your receipt is below.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "This is your payment receipt.",
    ),
    text: text(input.fullName, ["Payment received. Thank you.", "", ...details], brand),
  };
}

export function refundCompletedEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.amountPaise !== undefined && input.amountPaise !== null) {
    const amt = formatAmount(input.amountPaise);
    if (amt) details.push(`Amount refunded: ${amt}`);
  }
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.reason) details.push(`Reason: ${input.reason}`);

  return {
    subject: `Refund completed - ${brand}`,
    html: layout(
      brand,
      "Refund completed",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your refund has been processed.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "The amount may take a few days to appear in your account.",
    ),
    text: text(input.fullName, ["Your refund has been processed.", "", ...details], brand),
  };
}

export function appointmentReminderEmail(input: AppointmentEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details: string[] = [];
  if (input.doctorName) details.push(`Doctor: ${input.doctorName}`);
  if (input.slotDate) details.push(`Date: ${input.slotDate}`);
  if (input.startTime && input.endTime) details.push(`Time: ${input.startTime} - ${input.endTime}`);
  else if (input.startTime) details.push(`Time: ${input.startTime}`);
  details.push(`Appointment ID: ${input.appointmentId}`);
  if (input.amountPaise !== undefined && input.amountPaise !== null) {
    const amt = formatAmount(input.amountPaise);
    if (amt) details.push(`Fee: ${amt}`);
  }

  return {
    subject: `Appointment reminder - ${brand}`,
    html: layout(
      brand,
      "Appointment reminder",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>Your appointment is coming up soon.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      "Please arrive on time for your appointment.",
    ),
    text: text(input.fullName, ["Your appointment is coming up soon.", "", ...details], brand),
  };
}

export interface DoctorCredentialChangeRequestedEmailInput extends BaseTemplateInput {
  readonly doctorName: string;
  readonly doctorEmail: string;
  readonly doctorPhone: string;
  readonly requestId: string;
  readonly changes: readonly string[];
  readonly link: string;
}

/** Admin alert: a doctor proposed credential edits; the live profile is unchanged. */
export function doctorCredentialChangeRequestedEmail(
  input: DoctorCredentialChangeRequestedEmailInput,
): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details = [
    `Doctor: ${input.doctorName}`,
    `Doctor email: ${input.doctorEmail}`,
    `Doctor mobile: ${input.doctorPhone}`,
    `Request: ${input.requestId}`,
    "",
    "Proposed changes:",
    ...input.changes.map((change) => `- ${change}`),
    "",
    "The doctor remains live and bookable. The new values are not public until you approve them.",
  ];

  return {
    subject: `Doctor credential changes need approval - ${brand}`,
    html: layout(
      brand,
      "Credential changes need approval",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>A doctor submitted credential changes for review.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
       ${button(input.link, "Review credential changes")}`,
      "These values are proposals only. The doctor's current public profile stays unchanged until an admin approves them.",
    ),
    text: [
      ...text(input.fullName, details, brand).split("\n"),
      "",
      `Review credential changes: ${input.link}`,
    ].join("\n"),
  };
}

export interface DoctorScheduleChangeRequestedEmailInput extends BaseTemplateInput {
  readonly doctorName: string;
  readonly doctorEmail: string;
  readonly action: string;
  readonly details: readonly string[];
  readonly reason: string;
  readonly requestId: string;
  readonly note: string;
  readonly link: string;
}

/** Admin alert: a doctor proposed a schedule/time-off change; live data is unchanged. */
export function doctorScheduleChangeRequestedEmail(
  input: DoctorScheduleChangeRequestedEmailInput,
): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details = [
    `Doctor: ${input.doctorName}`,
    `Doctor email: ${input.doctorEmail}`,
    `Request: ${input.requestId}`,
    `Change: ${input.action}`,
    "",
    ...input.details,
    "",
    `Reason: ${input.reason}`,
    "",
    input.note,
  ];

  return {
    subject: `Doctor schedule change needs approval - ${brand}`,
    html: layout(
      brand,
      "Schedule change needs approval",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>A doctor submitted a schedule change for review.</p>
       <ul>${details.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
       ${button(input.link, "Review schedule change")}`,
      "The doctor's current schedule and existing bookings stay unchanged until you approve this request.",
    ),
    text: [
      ...text(input.fullName, details, brand).split("\n"),
      "",
      `Review schedule change: ${input.link}`,
    ].join("\n"),
  };
}

export interface DoctorScheduleChangeDecidedEmailInput extends BaseTemplateInput {
  readonly doctorName: string;
  readonly action: string;
  readonly details: readonly string[];
  readonly decision: "APPROVED" | "REJECTED";
  readonly reviewNote: string | null;
  readonly link: string;
}

/** Doctor-facing decision notice for a submitted schedule/time-off change. */
export function doctorScheduleChangeDecidedEmail(
  input: DoctorScheduleChangeDecidedEmailInput,
): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const heading = input.decision === "APPROVED" ? "Schedule change approved" : "Schedule change rejected";
  const outcome =
    input.decision === "APPROVED"
      ? "Your requested change has been applied to your live schedule."
      : "Your requested change was not applied. Your current schedule is unchanged.";
  const details = [
    `Change: ${input.action}`,
    "",
    ...input.details,
    "",
    outcome,
    ...(input.reviewNote !== null && input.reviewNote.trim().length > 0 ? [`Admin note: ${input.reviewNote}`] : []),
  ];

  return {
    subject: `${heading} - ${brand}`,
    html: layout(
      brand,
      heading,
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <ul>${details.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
       ${button(input.link, "View your schedule")}`,
      "Existing slots and bookings are never silently changed by a template edit. Time off only affects bookings once approved.",
    ),
    text: [...text(input.fullName, details, brand).split("\n"), "", `View your schedule: ${input.link}`].join("\n"),
  };
}

export interface AttendanceFollowUpEmailInput extends BaseTemplateInput {
  readonly patientName: string;
  readonly doctorName: string;
  readonly slotDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly link: string;
}

/** One-line nudge to the desk: a booking is still CONFIRMED after its slot ended. */
export function appointmentAttendanceFollowUpEmail(input: AttendanceFollowUpEmailInput): EmailContent {
  const brand = input.brand ?? DEFAULT_BRAND;
  const details = [
    `Patient: ${input.patientName}`,
    `Doctor: ${input.doctorName}`,
    `Date: ${input.slotDate}`,
    `Time: ${input.startTime} - ${input.endTime}`,
    "This booking is still CONFIRMED and needs review.",
  ];

  return {
    subject: `Booking needs review - ${brand}`,
    html: layout(
      brand,
      "Booking needs review",
      `<p>${escapeHtml(greeting(input.fullName))}</p>
       <p>This booking is still CONFIRMED and needs review.</p>
       <ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>
       ${button(input.link, "Review booking")}`,
      "No appointment status has been changed automatically. Please check in, complete, mark no-show or cancel as appropriate.",
    ),
    text: [
      ...text(input.fullName, details, brand).split("\n"),
      "",
      `Review booking: ${input.link}`,
    ].join("\n"),
  };
}
