import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { hashToken } from "../../src/lib/auth.js";
import { prisma } from "../../src/lib/prisma.js";
import { createAdmin, createLoginDoctor, createLoginPatient } from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const app = createApp();
let ipSequence = 0;

function nextTestIp(): string {
  ipSequence += 1;
  return `198.51.100.${ipSequence}`;
}

function refreshCookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = values.find((value) => value.startsWith("refresh_token="));
  if (!cookie) {
    throw new Error("Login did not set a refresh cookie.");
  }
  const value = cookie.split(";")[0];
  if (!value) {
    throw new Error("Refresh cookie was empty.");
  }
  return value;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 36 chunk 2: lockout, refresh rotation, and revocation", () => {
  it("locks a normalized identity after five consecutive password failures", async () => {
    const { user, password } = await createLoginPatient();
    const email = user.email;
    if (email === null) {
      throw new Error("Patient fixture must have an email.");
    }
    const ip = nextTestIp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: email.toUpperCase(), password: `${password}-wrong` })
        .expect(401);
    }

    const blocked = await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password })
      .expect(429);

    expect(blocked.body.error.code).toBe("TOO_MANY_ATTEMPTS");
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    const failures = await prisma.authAttempt.count({
      where: {
        identifierKey: email.toLowerCase(),
        purpose: $Enums.AuthAttemptPurpose.LOGIN,
        succeeded: false,
      },
    });
    expect(failures).toBe(5);
  });

  it("clears the consecutive-failure run after a successful login", async () => {
    const { user, password } = await createLoginPatient();
    const email = user.email;
    if (email === null) {
      throw new Error("Patient fixture must have an email.");
    }
    const ip = nextTestIp();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email, password: `${password}-wrong` })
        .expect(401);
    }

    await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password })
      .expect(200);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email, password: `${password}-wrong` })
        .expect(401);
    }

    await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password })
      .expect(200);
  });

  it("rotates refresh tokens and refuses reuse of the revoked token", async () => {
    const { user, password } = await createLoginPatient();
    const ip = nextTestIp();
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email: user.email, password })
      .expect(200);
    const originalCookie = refreshCookie(login);
    const originalToken = originalCookie.slice("refresh_token=".length);

    const rotated = await request(app)
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", ip)
      .set("Cookie", originalCookie)
      .expect(200);
    const rotatedCookie = refreshCookie(rotated);
    const rotatedToken = rotatedCookie.slice("refresh_token=".length);

    expect(rotatedToken).not.toBe(originalToken);
    const originalRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(originalToken) },
    });
    const rotatedRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rotatedToken) },
    });
    expect(originalRow?.revokedAt).not.toBeNull();
    expect(rotatedRow?.revokedAt).toBeNull();

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", ip)
      .set("Cookie", originalCookie)
      .expect(401);
  });

  it("revokes refresh sessions while account suspension immediately blocks access tokens", async () => {
    const admin = await createAdmin();
    const doctor = await createLoginDoctor();
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: admin.user.email, password: admin.password })
      .expect(200);
    const doctorLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: doctor.user.email, password: doctor.password })
      .expect(200);
    const doctorCookie = refreshCookie(doctorLogin);
    const doctorToken = doctorCookie.slice("refresh_token=".length);

    await request(app)
      .post(`/api/v1/doctors/${doctor.user.id}/suspend`)
      .set("Authorization", `Bearer ${adminLogin.body.accessToken}`)
      .send({ reason: "Integration test suspension" })
      .expect(200);

    const refreshRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(doctorToken) },
    });
    expect(refreshRow?.revokedAt).not.toBeNull();

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", doctorCookie)
      .expect(401);
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${doctorLogin.body.accessToken}`)
      .expect(403);
    expect(me.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });
});
