import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function databaseIdentity(connectionString: string): { host: string; port: string; name: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return fail("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return fail("TEST_DATABASE_URL must use the PostgreSQL protocol.");
  }

  let name: string;
  try {
    name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return fail("TEST_DATABASE_URL must include a valid database name.");
  }
  if (!name) {
    return fail("TEST_DATABASE_URL must include a database name.");
  }
  return { host: url.hostname, port: url.port || "5432", name };
}

if (process.env.NODE_ENV === "production") {
  fail("Refusing to reset a database while NODE_ENV=production.");
}
if (!testDatabaseUrl) {
  fail("Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test.");
}

const testIdentity = databaseIdentity(testDatabaseUrl);
if (!testIdentity.name.endsWith("_test")) {
  fail("Refusing to reset TEST_DATABASE_URL: its database name must end in _test.");
}

const appDatabaseUrl = process.env.DATABASE_URL;
if (appDatabaseUrl) {
  const appIdentity = databaseIdentity(appDatabaseUrl);
  if (testIdentity.name === appIdentity.name) {
    fail("Refusing to reset TEST_DATABASE_URL because it points to DATABASE_URL.");
  }
}

const prismaCli = path.join(serverRoot, "node_modules", "prisma", "build", "index.js");
const vitestCli = path.join(serverRoot, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(prismaCli) || !existsSync(vitestCli)) {
  fail("Test dependencies are missing. Install the server dependencies before running integration tests.");
}

const testEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  NODE_ENV: "test",
};

console.log("Resetting the isolated test database and applying migrations...");
const migration = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "reset", "--force"],
  { cwd: serverRoot, env: testEnv, stdio: "inherit" },
);
if (migration.error) {
  fail(`Could not run Prisma migrations: ${migration.error.message}`);
}
if (migration.status !== 0) {
  process.exit(migration.status ?? 1);
}

const tests = spawnSync(process.execPath, [vitestCli, "run", "--config", "vitest.config.ts"], {
  cwd: serverRoot,
  env: testEnv,
  stdio: "inherit",
});
if (tests.error) {
  fail(`Could not run Vitest: ${tests.error.message}`);
}
process.exit(tests.status ?? 1);
