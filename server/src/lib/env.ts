import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads Neon's root .env.local before server/.env.
 *
 * `neon deploy` writes the branch's DATABASE_URL (pooled) and
 * DATABASE_URL_UNPOOLED (direct) to the repository root, while this server's
 * own secrets live in server/.env. dotenv does not override values already in
 * process.env, so the first file loaded wins: locally that is Neon's branch;
 * on a host that injects env vars directly, neither file overrides the host.
 */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

config({ path: path.resolve(serverRoot, "../.env.local"), quiet: true });
config({ path: path.resolve(serverRoot, ".env"), quiet: true });
