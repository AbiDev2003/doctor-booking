import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { inviteDoctor } from "../../src/services/doctors/doctor.service.js";
import { createAdmin, createDoctor, createLoginPatient, TEST_PASSWORD, uniquePhone } from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 36 chunk 1: registration, email uniqueness, and login", () => {
  it("normalizes registration identity and rejects a duplicate email", async () => {
    const email = `Patient-${Date.now()}@Example.test`;
    const phone = uniquePhone();
    const response = await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: TEST_PASSWORD, fullName: "  Test Patient  ", phone })
      .expect(201);

    expect(response.body).not.toHaveProperty("accessToken");
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { patientProfile: true },
    });
    if (!user) {
      throw new Error("Registration did not persist the patient.");
    }
    expect(user.role).toBe($Enums.UserRole.PATIENT);
    expect(user.fullName).toBe("Test Patient");
    expect(user.passwordHash).not.toBe(TEST_PASSWORD);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.patientProfile?.phone).toBe(phone);

    const verification = await prisma.authToken.findFirst({
      where: { userId: user.id, purpose: $Enums.AuthTokenPurpose.EMAIL_VERIFICATION },
    });
    expect(verification).not.toBeNull();

    const duplicate = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: email.toUpperCase(), password: TEST_PASSWORD, fullName: "Duplicate", phone: uniquePhone() })
      .expect(409);
    expect(duplicate.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    expect(await prisma.user.count({ where: { email: email.toLowerCase() } })).toBe(1);
  });

  it("enforces email uniqueness between patient registration and doctor invitations", async () => {
    const doctor = await createDoctor();
    const doctorEmail = doctor.email;
    if (doctorEmail === null) {
      throw new Error("Doctor fixture must have an email.");
    }
    const admin = await createAdmin();
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: admin.user.email, password: admin.password })
      .expect(200);

    const registration = await request(app)
      .post("/api/v1/auth/register")
      .send({
        email: doctorEmail,
        password: TEST_PASSWORD,
        fullName: "Duplicate Doctor Email",
        phone: uniquePhone(),
      })
      .expect(409);
    expect(registration.body.error.code).toBe("EMAIL_ALREADY_EXISTS");

    const invitation = await request(app)
      .post("/api/v1/doctors")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ email: doctorEmail, fullName: "Duplicate Doctor Email" })
      .expect(409);
    expect(invitation.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    expect(await prisma.pendingInvitation.count({ where: { email: doctorEmail } })).toBe(0);
  });

  it("does not let an invitation claim take over an address registered after invitation", async () => {
    const admin = await createAdmin();
    const email = `invite-race-${Date.now()}@example.test`;
    const invitation = await inviteDoctor({
      actor: { id: admin.user.id, role: admin.user.role, name: admin.user.fullName },
      email,
      fullName: "Invited Doctor",
    });

    await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password: TEST_PASSWORD, fullName: "Registered Patient", phone: uniquePhone() })
      .expect(201);

    const claim = await request(app)
      .post("/api/v1/auth/claim-account")
      .send({ token: invitation.rawToken, password: TEST_PASSWORD })
      .expect(400);

    expect(claim.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.role).toBe($Enums.UserRole.PATIENT);
    expect(
      await prisma.pendingInvitation.count({
        where: { id: invitation.invitationId, consumedAt: null },
      }),
    ).toBe(1);
  });

  it("rejects an email change to an address owned by another account", async () => {
    const patient = await createLoginPatient();
    const doctor = await createDoctor();
    const patientEmail = patient.user.email;
    if (patientEmail === null) {
      throw new Error("Patient fixture must have an email.");
    }
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: patientEmail, password: patient.password })
      .expect(200);
    if (typeof login.body.accessToken !== "string") {
      throw new Error("Login did not return an access token.");
    }
    const doctorEmail = doctor.email;
    if (doctorEmail === null) {
      throw new Error("Doctor fixture must have an email.");
    }

    const response = await request(app)
      .post("/api/v1/auth/change-email")
      .set("Authorization", `Bearer ${login.body.accessToken}`)
      .send({ email: doctorEmail })
      .expect(409);

    expect(response.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    const unchanged = await prisma.user.findUnique({ where: { id: patient.user.id } });
    expect(unchanged?.pendingEmail).toBeNull();
  });

  it("authenticates with normalized email and returns an access token and refresh cookie", async () => {
    const { user, password } = await createLoginPatient();
    const email = user.email;
    if (email === null) {
      throw new Error("Patient fixture must have an email.");
    }
    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: email.toUpperCase(), password })
      .expect(200);

    expect(response.body).toMatchObject({
      userId: user.id,
      role: $Enums.UserRole.PATIENT,
      emailVerified: true,
    });
    expect(response.body.accessToken).toEqual(expect.any(String));
    const cookie = response.headers["set-cookie"];
    expect(cookie).toBeDefined();
    expect((Array.isArray(cookie) ? cookie : [cookie]).some((value) => value.startsWith("refresh_token="))).toBe(
      true,
    );

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${response.body.accessToken}`)
      .expect(200);
    expect(me.body.user).toMatchObject({ id: user.id, role: $Enums.UserRole.PATIENT });
  });

  it("returns the same authentication error for an unknown email and a wrong password", async () => {
    const { user, password } = await createLoginPatient();
    const wrongPassword = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: `${password}-wrong` })
      .expect(401);
    const unknownEmail = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: `unknown-${Date.now()}@example.test`, password })
      .expect(401);

    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });
});
