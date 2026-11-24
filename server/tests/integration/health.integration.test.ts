import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("health endpoint", () => {
  it("reports the API and database as healthy", async () => {
    await request(app)
      .get("/api/v1/health/")
      .expect(200)
      .expect({ status: "ok", db: "up" });
  });

  it("echoes the request id when the database check fails", async () => {
    const requestId = "health-db-down-request";
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("database unreachable"));

    const response = await request(app)
      .get("/api/v1/health/")
      .set("x-request-id", requestId)
      .expect(503);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body).toEqual({ db: "down", requestId });
  });
});
