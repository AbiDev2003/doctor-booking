// Local database bootstrap runner.
//
// Creates the `doctor_booking` role and database by executing
// prisma/bootstrap.local.sql. The password is deliberately absent from that
// SQL: it is read out of DATABASE_URL here and handed to psql through the
// environment, where the script's \getenv picks it up. That keeps the secret
// out of the repo, out of shell history, and out of process listings.
//
//   npm run db:bootstrap
//
// This connects as the `postgres` superuser, so you are prompted for that
// password. It is a different secret and is never read or stored here.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadEnv({ path: path.join(serverRoot, ".env"), quiet: true });

function fail(message: string, hint?: string): never {
  console.error(message);
  if (hint) console.error(hint);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  fail(
    "DATABASE_URL is not set in server/.env.",
    "Copy server/.env.example to server/.env and fill it in.",
  );
}

let url: URL;
try {
  url = new URL(databaseUrl);
} catch {
  fail(
    "DATABASE_URL in server/.env is not a valid connection string.",
    "Expected something like postgresql://doctor_booking:password@localhost:5432/doctor_booking",
  );
}

// WHATWG URL does not percent-decode userinfo for non-special schemes, and
// postgresql: is one (it only decodes for http:, https:, ws:, wss:, ftp:).
// Without this decode, a password containing @ / : or a quote is passed through
// still-encoded and CREATE ROLE silently stores the wrong password.
function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray '%' means the value was never percent-encoded to begin with.
    return value;
  }
}

const password = decodeUserinfo(url.password);

if (!password) {
  fail(
    "DATABASE_URL in server/.env has no password component.",
    "The bootstrap sets the role's password from this URL, so it must be present.",
  );
}

if (url.username !== "doctor_booking") {
  console.warn(
    `warning: DATABASE_URL uses the role "${url.username}", but bootstrap.local.sql ` +
      `creates "doctor_booking". Update the SQL if you intend to use a different name.`,
  );
}

const child = spawn(
  "psql",
  [
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-f",
    path.join(serverRoot, "prisma", "bootstrap.local.sql"),
  ],
  {
    // Passed via the environment rather than argv: argv is world-readable
    // through `ps` on Linux, the environment is not.
    env: { ...process.env, BOOTSTRAP_DB_PASSWORD: password },
    stdio: "inherit",
  },
);

child.on("error", (err: Error) => {
  fail(
    `Could not run psql: ${err.message}`,
    "Install the PostgreSQL client tools, or add psql to your PATH.",
  );
});

child.on("close", (code: number | null) => {
  process.exit(code ?? 1);
});
