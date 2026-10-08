import type { $Enums } from "../generated/prisma/client.js";

/**
 * The one place `req.user` is declared, extracted from `middleware/auth.ts` so
 * every TypeScript program in this repo sees it. The first program
 * (`tsconfig.json`, `src/**`) would pick it up from the middleware file, but the
 * second (`tsconfig.tools.json`, tests and build scripts) only pulls in the
 * files a test happens to import — and `rbac.test.ts` exercises gates that
 * never import `requireAuth`. Co-locating an augmentation with its producer
 * makes its visibility depend on import graphs; a named types module makes it
 * depend on `include`, which both configs list.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // `role` is the enum, not `string`: `requireRole` compares it against
      // `$Enums.UserRole` members and a bare string would let any typo compile.
      // `phone` joins the same one-query pattern as `doctorProfile` in
      // `requireAuth` — nullable for every non-patient — because Day 11's
      // profile screen reads it from /auth/me and a second "my phone" endpoint
      // would be a second source of truth for the caller's own identity.
      // `name` is User.fullName, added for Day 12: every §20 audit row carries
      // an `actorName` snapshot taken at action time, and without it on the
      // session every route would re-read the actor row it already fetched —
      // or worse, snapshot from a stale second query.
      user?: { id: string; role: $Enums.UserRole; email: string | null; phone: string | null; name: string };
    }
  }
}

export {};
