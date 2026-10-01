// Prisma CLI configuration.
//
// Prisma 7 no longer loads .env by itself, so the explicit `dotenv/config`
// import is required — without it every CLI command fails with an undefined
// DATABASE_URL. The datasource URL lives here rather than in schema.prisma
// because v7 deprecated it in the schema.
import "dotenv/config";
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
    url: env("DATABASE_URL"),
  },
});
