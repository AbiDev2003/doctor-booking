import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountDeactivatedEmail,
  accountInvitationEmail,
  appointmentAttendanceFollowUpEmail,
  allSessionsRevokedEmail,
  doctorCredentialChangeRequestedEmail,
  doctorScheduleChangeDecidedEmail,
  doctorScheduleChangeRequestedEmail,
  emailChangeVerificationEmail,
  emailVerificationEmail,
  passwordResetCompletedEmail,
  passwordResetEmail,
} from "../src/lib/emailTemplates.js";

const link = "https://clinic.example/verify-email?token=abc123";

describe("email verification template", () => {
  it("carries the link in both HTML and text", () => {
    const email = emailVerificationEmail({ fullName: "Asha Rao", link, expiresIn: "15 minutes" });
    assert.match(email.html, /verify-email\?token=abc123/);
    assert.match(email.text, /verify-email\?token=abc123/);
  });

  it("escapes a hostile display name instead of injecting markup", () => {
    const email = emailVerificationEmail({
      fullName: "<script>alert(1)</script>",
      link,
      expiresIn: "15 minutes",
    });
    assert.equal(email.html.includes("<script>"), false);
    assert.match(email.html, /&lt;script&gt;/);
  });
});

describe("password reset template", () => {
  it("shows a link for the LINK method", () => {
    const email = passwordResetEmail({ fullName: "Asha", method: "LINK", link, expiresIn: "15m" });
    assert.match(email.text, /Reset your password here/);
    assert.match(email.text, /abc123/);
  });

  it("shows the six-digit code for the OTP method and no link", () => {
    const email = passwordResetEmail({ fullName: "Asha", method: "OTP", otp: "012345", expiresIn: "15m" });
    assert.match(email.text, /012345/);
    assert.equal(email.html.includes("https://"), false);
  });
});

describe("account templates", () => {
  it("uses the explicit role label on an invitation", () => {
    const email = accountInvitationEmail({
      fullName: "Dr Rao",
      link: "https://clinic.example/claim-account?token=claim1",
      roleLabel: "doctor",
      expiresIn: "24h",
    });
    assert.match(email.text, /as a doctor/);
    assert.match(email.html, /claim-account\?token=claim1/);
  });

  it("warns the new address on an email change", () => {
    const email = emailChangeVerificationEmail({ fullName: "Asha", link, expiresIn: "15m" });
    assert.match(email.text, /current address stays active/);
  });

  it("states that the password changed", () => {
    const email = passwordResetCompletedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /password was changed/);
  });

  it("states that all sessions were signed out", () => {
    const email = allSessionsRevokedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /security notice/);
  });

  it("states that the account was deleted", () => {
    const email = accountDeactivatedEmail({ fullName: "Asha" });
    assert.match(email.subject.toLowerCase(), /account was deleted/);
  });
});

describe("doctor credential change request template", () => {
  const reviewLink = "https://clinic.example/admin/doctors?credentialRequest=request-123";

  it("includes the doctor's identifying details, proposed changes and review link", () => {
    const email = doctorCredentialChangeRequestedEmail({
      fullName: "Clinic Admin",
      doctorName: "Dr Mehta",
      doctorEmail: "doctor@example.test",
      doctorPhone: "+919876543210",
      requestId: "request-123",
      changes: ["Qualification: MBBS → MD Cardiology"],
      link: reviewLink,
    });

    assert.match(email.subject.toLowerCase(), /approval/);
    for (const value of [
      "Dr Mehta",
      "doctor@example.test",
      "+919876543210",
      "request-123",
      "Qualification: MBBS → MD Cardiology",
      "remains live and bookable",
    ]) {
      assert.ok(email.text.includes(value), `missing ${value}`);
      assert.ok(email.html.includes(value), `missing ${value}`);
    }
    assert.match(email.html, /credentialRequest=request-123/);
    assert.match(email.text, /credentialRequest=request-123/);
  });
});

describe("doctor schedule change templates", () => {
  const requestLink = "https://clinic.example/admin/schedule-requests?request=request-456";

  it("tells admins what is proposed, who proposed it, and that live data is untouched", () => {
    const email = doctorScheduleChangeRequestedEmail({
      fullName: "Clinic Admin",
      doctorName: "Dr Mehta",
      doctorEmail: "doctor@example.test",
      action: "Mark time off",
      details: ["Date: 2026-12-01", "Time: 09:00 - 13:00", "Confirmed bookings that would be affected: 2"],
      reason: "Family commitment",
      requestId: "request-456",
      note: "No slots are hidden and no patients are flagged until approval.",
      link: requestLink,
    });

    assert.match(email.subject.toLowerCase(), /approval/);
    for (const value of [
      "Dr Mehta",
      "doctor@example.test",
      "request-456",
      "Mark time off",
      "Family commitment",
      "No slots are hidden and no patients are flagged until approval.",
    ]) {
      assert.ok(email.text.includes(value), `missing ${value}`);
      assert.ok(email.html.includes(value), `missing ${value}`);
    }
    assert.match(email.html, /schedule-requests\?request=request-456/);
    assert.match(email.text, /schedule-requests\?request=request-456/);
  });

  it("tells the doctor whether the request was approved or rejected", () => {
    for (const decision of ["APPROVED", "REJECTED"] as const) {
      const email = doctorScheduleChangeDecidedEmail({
        fullName: "Dr Mehta",
        doctorName: "Dr Mehta",
        action: "Weekly window edit",
        details: ["Weekday: MON -> TUE"],
        decision,
        reviewNote: decision === "REJECTED" ? "Use Wednesday instead" : null,
        link: "https://clinic.example/doctor/schedule",
      });

      assert.match(email.subject.toLowerCase(), new RegExp(decision.toLowerCase()));
      assert.match(email.text, /Weekday: MON -> TUE/);
      if (decision === "APPROVED") {
        assert.match(email.text, /applied to your live schedule/);
      } else {
        assert.match(email.text, /not applied/);
        assert.match(email.text, /Use Wednesday instead/);
      }
    }
  });
});

describe("attendance follow-up template", () => {
  const reviewLink = "https://clinic.example/admin/appointments?scope=needsAttention&date=2026-11-25";

  it("names the patient, doctor, slot and the fact that the booking is still open", () => {
    const email = appointmentAttendanceFollowUpEmail({
      fullName: "Desk Admin",
      patientName: "Asha Rao",
      doctorName: "Dr Mehta",
      slotDate: "2026-11-25",
      startTime: "09:00",
      endTime: "10:00",
      link: reviewLink,
    });

    assert.match(email.subject.toLowerCase(), /needs review/);
    for (const value of ["Asha Rao", "Dr Mehta", "2026-11-25", "09:00 - 10:00", "still CONFIRMED"]) {
      assert.ok(email.text.includes(value), `missing ${value}`);
      assert.ok(email.html.includes(value), `missing ${value}`);
    }
  });

  it("carries the deep link in both HTML and text", () => {
    const email = appointmentAttendanceFollowUpEmail({
      fullName: "Desk Admin",
      patientName: "Asha Rao",
      doctorName: "Dr Mehta",
      slotDate: "2026-11-25",
      startTime: "09:00",
      endTime: "10:00",
      link: reviewLink,
    });
    assert.match(email.html, /scope=needsAttention/);
    assert.match(email.text, /scope=needsAttention/);
  });
});
