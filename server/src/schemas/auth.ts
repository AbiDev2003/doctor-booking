/**
 * Day 34: these schemas now live in `shared/validation/auth.ts` so the client
 * can validate with the exact same objects. Re-exported here to keep every
 * existing server import (`schemas/auth.js`) stable.
 */
export * from "../shared/validation/auth.js";
