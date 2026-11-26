// Prisma CLI configuration.
//
// Prisma 7 no longer loads .env by itself, so an explicit dotenv load is
// required — without it every CLI command fails with an undefined URL. The
// shared loader reads Neon's root .env.local first, then server/.env.
// The datasource URL lives here rather than in schema.prisma because v7
// deprecated it in the schema.
import "./src/lib/env.js";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",

    // The seed hook for `prisma db seed` and `prisma migrate dev`.
    //
    // MEASURED BEHAVIOUR, not documentation: `prisma migrate reset` does NOT
    // run this. Verified on Prisma 7 by resetting and counting — every table
    // came back 0. So a reset leaves an empty database and the seed must be run
    // as a second command. `npm run db:reset` in package.json chains the two
    // for that reason; running `prisma migrate reset` on its own is a footgun
    // that looks like it seeded when it did not.
    //
    // `tsx` (not `ts-node`) to match every other script in this package, and
    // `.ts` rather than `.js` because nothing under prisma/ is compiled.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Neon migrations use the direct endpoint; PgBouncer (pooled endpoint) is
    // transaction-mode and can leave Prisma's advisory lock held. The fallback
    // keeps local development unchanged when only DATABASE_URL is present.
    url: process.env.DATABASE_URL_UNPOOLED ?? env("DATABASE_URL"),
  },
});
