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
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
