import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { writeAudit } from "../../src/services/audit.service.js";
import { createAdmin, createLoginPatient } from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const app = createApp();

async function accessToken(email: string | null, password: string): Promise<string> {
  if (email === null) {
    throw new Error("Login fixture must have an email.");
  }
  const response = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
  if (typeof response.body.accessToken !== "string") {
    throw new Error("Login did not return an access token.");
  }
  return response.body.accessToken;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 38: security and review sweep", () => {
  it("exposes no HTTP write path for audit rows", async () => {
    const admin = await createAdmin();
    const token = await accessToken(admin.user.email, admin.password);

    await writeAudit(prisma, {
      action: "REVIEW_SWEEP_AUDIT",
      targetType: "user",
      targetId: admin.user.id,
      actor: { id: admin.user.id, role: $Enums.UserRole.ADMIN, name: admin.user.fullName },
      reason: "review sweep proof",
    });
    const written = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: admin.user.id, action: "REVIEW_SWEEP_AUDIT" },
    });

    await request(app)
      .post("/api/v1/audit")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(404);
    await request(app)
      .patch(`/api/v1/audit/${written.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "rewritten" })
      .expect(404);
    await request(app)
      .delete(`/api/v1/audit/${written.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: written.id } });
    expect(after.action).toBe("REVIEW_SWEEP_AUDIT");
    expect(after.reason).toBe("review sweep proof");
    expect(await prisma.auditLog.count({ where: { targetId: admin.user.id } })).toBe(1);
  });

  it("echoes a supplied request id in every error envelope", async () => {
    const requestId = "review-sweep-request-id";

    const responses = [
      await request(app)
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json")
        .set("x-request-id", requestId)
        .send("{")
        .expect(400),
      await request(app).get("/api/v1/audit").set("x-request-id", requestId).expect(401),
      await request(app).get("/api/v1/review-sweep-missing").set("x-request-id", requestId).expect(404),
      await request(app)
        .post("/api/v1/auth/register")
        .set("x-request-id", requestId)
        .send({ email: "not-an-email" })
        .expect(422),
    ];

    for (const response of responses) {
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(response.body.error.requestId).toBe(requestId);
    }
  });

  it("requires authentication on every protected router mount", async () => {
    const protectedMounts = [
      "/api/v1/admin",
      "/api/v1/appointments",
      "/api/v1/audit",
      "/api/v1/clinics",
      "/api/v1/doctors",
      "/api/v1/patients",
      "/api/v1/payments",
      "/api/v1/schedules",
      "/api/v1/slots",
      "/api/v1/staff",
      "/api/v1/unavailabilities",
      "/api/v1/users",
    ];

    for (const path of protectedMounts) {
      const response = await request(app).get(path).expect(401);
      expect(response.body.error.code).toBe("AUTH_REQUIRED");
    }
  });

  it("keeps the health and storefront reads public", async () => {
    await request(app).get("/api/v1/health").expect(200, { status: "ok", db: "up" });
    await request(app).get("/api/v1/public/doctors").expect(200);
  });

  it("reaches webhook signature validation without a session", async () => {
    const response = await request(app)
      .post("/api/v1/payments/webhook")
      .set("Content-Type", "application/json")
      .send("{}");

    expect(response.body.error.code).not.toBe("AUTH_REQUIRED");
    expect([403, 503]).toContain(response.status);
    expect(["WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_NOT_CONFIGURED"]).toContain(response.body.error.code);
  });

  it("keeps admin-only reads away from an ordinary patient", async () => {
    const patient = await createLoginPatient();
    const token = await accessToken(patient.user.email, patient.password);

    const response = await request(app).get("/api/v1/audit").set("Authorization", `Bearer ${token}`).expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
