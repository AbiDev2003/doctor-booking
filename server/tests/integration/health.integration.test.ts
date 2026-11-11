import request from "supertest";
import { afterAll, describe, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";

const app = createApp();

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
});
