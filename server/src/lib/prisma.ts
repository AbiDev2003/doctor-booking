import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../config.js";
import { PrismaClient } from "../generated/prisma/client.js";

// pg defaults to connectionTimeoutMillis: 0, meaning it waits forever.
// Prisma 6 defaulted to 5s, so leaving this unset would turn a stopped
// database into a hung request instead of the 503 the health check reports.
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

export const prisma = new PrismaClient({ adapter });
