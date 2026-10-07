import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../config.js";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

// pg defaults to connectionTimeoutMillis: 0, meaning it waits forever.
// Prisma 6 defaulted to 5s, so leaving this unset would turn a stopped
// database into a hung request instead of the 503 the health check reports.
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

export const prisma = new PrismaClient({ adapter });

/**
 * Either the root client or an interactive-transaction client. Both expose the
 * same delegates, so helpers that write accept one or the other and stay
 * correct when called from inside $transaction — reaching for the root `prisma`
 * inside a transaction uses a second connection, which is neither atomic nor
 * able to see the transaction's uncommitted rows.
 *
 * Lives here rather than beside any one service since Day 11 gave it a second
 * home: `auth.service.ts` (Day 7) declared it privately, and `audit.service.ts`
 * needs the identical type — one definition next to the client it describes,
 * rather than three private copies that can drift.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * True for the one Prisma error that means "a unique index said no".
 *
 * The retry/fallback paths around unique constraints (issueResetToken's OTP
 * redraw, the email-change accepts racing another session for the same
 * address) need to tell "the constraint caught a race" apart from "the
 * database is down" — a 409 for the second case would mask an outage, and a
 * retry of the first case inside a transaction Postgres has already aborted is
 * a bug. Exported rather than kept beside either caller because Day 11 gave it
 * two, and an error classifier duplicated is a classifier that drifts.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
