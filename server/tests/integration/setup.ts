import { beforeAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";

/**
 * §6.3 caps login attempts at 20/min/IP. Every integration fixture logs in
 * through the real route, and Supertest gives them all the same loopback IP,
 * so files later in the run inherit an already-exhausted budget (the Day 37
 * fixtures pushed the Day 36 authorization file over the edge).
 *
 * The test database is reset once per suite; give each file a fresh §6.3
 * window without touching production configuration or weakening the limiter.
 */
beforeAll(async () => {
  await prisma.authAttempt.deleteMany();
});
