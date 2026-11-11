import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Shared patient search for the admin directory and the desk slot view.
 *
 * Two modes, matching the approved UX:
 * - digits (at least 2) search the phone number; short prefixes match anywhere
 *   after the country code, full numbers match exactly;
 * - anything else is a fuzzy NAME search backed by pg_trgm, so "abonash"
 *   finds Abinash/Avinash/Abhinash as well as exact substrings.
 *
 * The trigram query is raw because Prisma has no similarity operator. It is
 * still parameterised through `Prisma.sql`, never string-concatenated.
 */
export function normalizeNameSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPhoneSearch(value: string): boolean {
  return /^[+\d][\d\s()\-]*$/.test(value.trim());
}

export async function findPatientIds(search: string, limit: number): Promise<string[]> {
  const trimmed = search.trim();
  if (trimmed === "") return [];

  const ids: string[] = [];

  if (isPhoneSearch(trimmed)) {
    // Stored phones are E.164 ("+919876543210") while desk users type a local
    // prefix ("98765"). `contains` on the digits is the useful definition of
    // prefix here; an exact full number naturally matches too.
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 2) return [];
    const rows = await prisma.user.findMany({
      where: {
        role: "PATIENT",
        patientProfile: { phone: { contains: digits } },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    ids.push(...rows.map((row) => row.id));
  } else {
    const normalized = normalizeNameSearch(trimmed);
    if (normalized.length > 0) {
      const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "users"
        WHERE "role" = 'PATIENT'
          AND (
            lower("full_name") LIKE ${`%${normalized}%`}
            OR similarity(lower("full_name"), ${normalized}) > 0.15
          )
        ORDER BY similarity(lower("full_name"), ${normalized}) DESC, "created_at" DESC
        LIMIT ${limit}
      `);
      ids.push(...rows.map((row) => row.id));

      // Email is still a useful exact-ish fallback for admin lookups.
      if (ids.length < limit) {
        const emailRows = await prisma.user.findMany({
          where: {
            role: "PATIENT",
            id: { notIn: ids },
            email: { contains: trimmed, mode: "insensitive" },
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
          take: limit - ids.length,
        });
        ids.push(...emailRows.map((row) => row.id));
      }
    }
  }

  return [...new Set(ids)].slice(0, limit);
}
