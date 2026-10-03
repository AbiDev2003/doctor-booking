# Code Plan — Day-by-Day Build Guide

Derived from `plan.md`. This is the **execution order**, not a new spec. When a task here
and a rule in `plan.md` disagree, `plan.md` wins — follow it and fix this file.

**Assumptions:** one developer, ~4–6 focused hours a day, solo localhost MVP, no Docker/AWS
(§2 defers all of it). Days are ordered by dependency, not by feature appeal — you cannot
book an appointment before a slot exists, and you cannot take payment before an
appointment exists.

**Current starting state (verified):**
- `client/` — Vite + React + TS shell exists, `npm run dev`/`build`/`lint` work.
- `server/` — Express + TS exists with one `/api/v1/health` route, `tsx watch` works.
- No `node_modules` installed yet, no `.env`, no `prisma/`, no git repo, no root
  `README.md`, no `.env.example`.
- So Day 1 is genuinely "connect what exists", not "start from scratch."

**Rules that apply every single day:**
- Run `npm run lint` and the typecheck before you commit. Green or it didn't happen.
- One feature branch per phase (`feature/auth`, `feature/scheduling`, …), §34.
- Meaningful commits, never commit `.env`, §34.
- Server business rules live on the server, never trust the client, §3.4.
- Every phase ends by hitting its **Definition of Done** (below) before moving on.

**Legend:** `[S]` server · `[C]` client · `[DB]` database/migration · `[T]` tests

---

## Phase 0 — Foundation (Days 1–3)

The goal of this phase: the two existing apps install, talk to a real database, and
`/health` proves the DB round-trips. Everything later depends on this.

### Day 1 — Install, git, and wire the two halves together
- `npm install` in `client/` and `server/`.
- `git init` at the repo root; add `.gitignore` (ignore `node_modules`, `dist`, `.env`,
  `*.local`). First commit: `chore: initialise repo with client and server scaffolds`.
- Create the `main` + `develop` branches (§34).
- Add a root `README.md` (how to run both apps) and a root `package.json` with two scripts:
  `dev:client`, `dev:server` (just document the two-terminal flow — no monorepo tooling yet).
- Confirm versions: `node -v`, `npm -v`, `psql --version`, `git --version`.
- **DoD:** both `npm run dev` processes start with no errors.

### Day 2 — Environment config + server foundation
- `[S]` `npm i zod cors pino pino-http dotenv` and `npm i -D @types/cors`.
- `server/.env` + `server/.env.example`: `DATABASE_URL`, `PORT`, `JWT_ACCESS_SECRET`,
  `ACCESS_TOKEN_TTL`, `RESEND_API_KEY`, `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `CLIENT_URL`, `APP_TIMEZONE` (§35).
  (`JWT_REFRESH_SECRET` was listed here and never shipped: the refresh token is an
  opaque random string stored as SHA-256 so it can be revoked (§6.3), so nothing
  signs or verifies it and the var would have had no reader.)
- Add a tiny config module in `server/src/config.ts` that reads and **validates** env with
  Zod and crashes fast on a missing var. Never read `process.env` ad-hoc elsewhere.
- `server/src/lib/logger.ts` — the Pino instance. `server/src/middleware/requestId.ts` —
  one request ID per request, carried in every log line and echoed in error responses
  (§19, §32). Doing it now means no later retrofit.
- Split the entry point: `server/src/app.ts` builds the Express app and does **not** listen;
  `server/src/server.ts` only calls `listen`. Phase 9's Supertest tests import `app.ts`.
- Add CORS restricted to `CLIENT_URL` (`http://localhost:5173`); `express.json()`;
  `middleware/errorHandler.ts` + `middleware/notFound.ts`; `/api/v1/health` scaffolded
  (the DB check lands on Day 3).
- Server lint/typecheck: add ESLint + `lint` and `typecheck` scripts, and set
  `"types": ["node"]` in `server/tsconfig.json` — it is currently `[]`, so `process` and
  the Prisma client will not typecheck.
- **DoD:** `npm run lint` + typecheck green; the server boots; a missing env var stops it
  with a clear message; `/api/v1/health` returns `200`.

### Day 3 — PostgreSQL + Prisma connect
- Create a **non-superuser** role and the database, so `DATABASE_URL` never points at
  `postgres`: `CREATE ROLE doctor_booking LOGIN CREATEDB PASSWORD '…';` then
  `CREATE DATABASE doctor_booking OWNER doctor_booking;`. The role needs `CREATEDB`
  because `migrate dev` provisions a shadow database, and stays non-superuser so
  `DATABASE_URL` remains least-privilege.
- `[S]` The bootstrap SQL is gitignored (`prisma/bootstrap.local.sql`) and holds **no
  password**. `server/scripts/db-bootstrap.ts` reads the password out of
  `DATABASE_URL`, `decodeURIComponent`s it, and passes it to psql through
  `BOOTSTRAP_DB_PASSWORD` (`\getenv` + `:'var'`, which escapes it as a SQL literal).
  Two traps recorded here: WHATWG `URL` does **not** percent-decode userinfo for
  `postgresql:` (a non-special scheme), so the decode must be explicit; and psql's
  `\quit <n>` is ignored on PG 18, so the "is the password set" check that must affect
  the exit code lives in the Node wrapper, not the SQL. Run via `npm run db:bootstrap`.

- `[S]` Prisma 7 is ESM-only. The `server/` ESM conversion (`"type": "module"` plus `.js`
  extensions on relative imports) landed on Day 2. Keep tsconfig at `module: nodenext` /
  `moduleResolution: nodenext` — **not** `bundler`: the generated client emits `.js` import
  specifiers, which `tsc` only accepts under `nodenext`, and `tsx` does resolve `.js` to the
  on-disk `.ts` (both verified). Stay on **7.x**; 8.x is still RC.
- `npm i @prisma/client @prisma/adapter-pg` and `npm i -D prisma`; hand-write
  `prisma/schema.prisma` with a placeholder model. The generator is
  `provider = "prisma-client"` with a **required** `output` (e.g. `../src/generated/prisma`,
  gitignored) — v7 no longer generates into `node_modules`.
- `server/prisma.config.ts` with `import "dotenv/config"` and
  `defineConfig({ schema, migrations, datasource: { url: env("DATABASE_URL") } })`. v7 does
  **not** auto-load `.env` and deprecates `datasource.url` in the schema; this file is the
  source of truth for the CLI.
- `server/src/lib/prisma.ts` — `new PrismaClient({ adapter: new PrismaPg({ connectionString:
  config.DATABASE_URL }) })`. v7 requires a driver adapter (node-pg); the old
  `datasources: { db: { url } }` form is gone.
- `npx prisma migrate dev --name init`, then `npx prisma generate` — **explicitly**: v7
  removed `--skip-generate`/`--skip-seed` and no longer generates or seeds on its own.
- Health route runs a real `SELECT 1` via `$queryRaw`; unreachable DB → `503 {db:"down"}`.
- **DoD:** `/api/v1/health` returns `200 {status:"ok", db:"up"}`; `prisma studio` opens the
  DB; `dropdb → migrate dev → generate` reproduces it from scratch.
- **Phase 0 complete.** Merge `feature/foundation` → `develop` and tag the milestone.

---

## Phase 1 — Database and Core Domain (Days 4–6)

Goal: the whole domain fits in the schema, and the DB can be thrown away and rebuilt from
migrations alone. From here on, the schema is the contract.

### Day 4 — Prisma schema: identity + clinic

**Naming convention, locked for every model from here on:** Prisma fields are `camelCase` and
**every** field is `@map`ped to `snake_case` in PostgreSQL (`bookedCount` → `booked_count`).
It is fixed on the first real schema because every later migration — including the hand-written
SQL ones in Day 6 — inherits the spelling, and renaming afterwards means rewriting all of them.
TypeScript never sees the snake_case form; raw SQL and psql always do.

**Three more conventions, locked with it:**

- **Ids:** `@default(uuid(7))` on every model, with `@db.Uuid` on the column. Prisma Client generates
  a time-ordered v7 uuid, so it is unguessable but keeps index locality on the high-write tables
  (`appointments`, `audit_log`, `notifications`) where random uuid v4 fragments the index. Table names
  are plural via `@@map` (`Appointment` → `appointments`).
  - **Client-generated, not `dbgenerated("uuidv7()")`**, even though PostgreSQL 18.3 has a native
    `uuidv7()`. Prisma's `dbgenerated()` defaults are a documented source of phantom migrations — the
    string you write and the value the DB returns can disagree, and `migrate dev` then wants a
    migration on every run ([#24240](https://github.com/prisma/prisma/issues/24240),
    [#9823](https://github.com/prisma/prisma/issues/9823)). The native function buys nothing here
    because every insert goes through Prisma; the only hand-written SQL in this plan is DDL, `CHECK`s
    and guarded `UPDATE`s, none of which inserts a row.
- **Enums:** the enum *type* is mapped to `snake_case` (`@@map("appointment_status")`) but the
  *values are stored exactly as written* — uppercase, no per-value `@@map`. §23's hand-written SQL
  is literally `status IN ('CONFIRMED','ARRIVED')`; lowercasing the stored values would make that
  SQL wrong on the day it is written.
- **Column types:** every instant is `@db.Timestamptz(3)`, so "all timestamps are UTC" (§3.2) is a
  database guarantee rather than a convention that a session timezone could reinterpret. Local
  calendar/wall-clock values use `@db.Date` and `@db.Time(0)`. Money is `Int` paise (§17) — never
  `BigInt`, which would break `JSON.stringify` at the API edge in Phase 6, far from the cause.
- **Referential actions:** `Restrict` everywhere (Prisma's default), never `Cascade` on
  appointment / payment / history / audit rows. `SetNull` only where a nullable link must survive
  its parent. Deletion is deactivation/anonymisation, never a row delete (§6.1, §5.1).

**Enum values: transcribe, do not invent (locked).** `plan.md` §24 now carries **one table of every
enum in the system** — Prisma enum name, `@@map` type name, values, and the section each came from.
That table is the single source; nothing in this guide restates it, because a second copy is a second
thing to drift. Read it, write each enum from it, and do not add a value the plan does not have. Four
traps it exists to prevent, each of which is a real bug rather than a style question:

- `RESCHEDULED` belongs to `AppointmentEventType`, **not** to `AppointmentStatus` (§13, §14), and
  `AppointmentEventType` has no `CONFIRMED` value — the row is born `CONFIRMED` (§13), so `BOOKED`
  is that event. §13's timeline prose lists "confirmed", but adding a `CONFIRMED` event would
  duplicate `BOOKED`.
- `PENDING` stays declared in `AppointmentStatus` and **nothing may ever write it** (§13). It is kept
  only for forward compatibility.
- `PaymentStatus` never gets `SUCCESS` — `PAID` is the only payment success value; `SUCCESS` is
  `RefundStatus` vocabulary (§17).
- `AuditLog.action` is a `String` (`SCREAMING_SNAKE`, e.g. `APPOINTMENT_CAPACITY_CHANGE`) and every
  `reason` field is free text — neither is an enum (§20 gives *examples*, and a closed enum would
  make every new audited action a migration; §8.4 requires a reason, not a reason code).
- `NotificationType` is the one open list: one `SCREAMING_SNAKE` value per §18 event, no grouping, no
  catch-all. Only `REMINDER` is named by the plan, because §23's constraint SQL quotes it.

- `Clinic` (single row, config record). §3.2 puts **every clinic number** in this one record so
  nothing is a magic constant in code, so it is created here and not extended in Phase 4:
  `timezone`, `currency`, `defaultConsultationFee`, `bookingHorizonDays` (60), `cancelCutoffMinutes`
  (60), `holdDurationMinutes` (10), `minLeadMinutes` (0), `reminderLeadMinutes` (120),
  `maxActiveBookingsPerPatient` (3). The defaults above are the locked §3.2 values, seeded in
  Day 6. `accessTokenTtlMinutes` is **not** a Clinic column — the `ACCESS_TOKEN_TTL` env var
  from Day 2 is the single source for it in a single-clinic app, and duplicating it into the DB
  would give the same setting two places that can disagree.
- `User` (`role` enum `PATIENT|DOCTOR|STAFF|ADMIN`; `email` **unique and nullable** — null only
  for a provisional desk patient, §6.4/§16; `passwordHash` **nullable**; `emailVerifiedAt?`;
  `pendingEmail?`; `isDeactivated`). No OAuth, no `Department`.
  - `passwordHash` is nullable on purpose (§5.1). The first admin and every doctor/staff account
    are created **without** a password — the person claims the account through the §6.2 reset
    email, and no temporary password is ever generated or handed over. `null` therefore *means*
    "account exists, not claimed yet", and every login path must treat it as **cannot
    authenticate** rather than comparing it. Patient self-registration writes a real hash at once.
  - `pendingEmail?` holds an unverified email change (§6.1). The active `email` only changes when
    the link is opened, so there is never a half-changed identity.
  - **No `phone` on `User`.** The phone number is patient identity data (§16) and lives on
    `PatientProfile`, so exactly one copy of it exists and the desk lookup has one key to hit.
- **Two seed inputs added to `.env.example` and the config schema on this day**, because Day 6's
  seed cannot invent them: `CLINIC_OWNER_EMAIL` (§5.1 already requires the bootstrap owner email to
  come from environment configuration, and no day had ever named the variable) and the optional
  `SEED_PATIENT_PASSWORD` (the two seeded patients are self-registered accounts and need a real
  hash — see Day 6). Both are seed-only inputs, optional, and never hardcoded in a fixture: a
  hardcoded address becomes the first admin of whoever runs the seed.
- `PatientProfile` (1:1 `User`, `fullName`, `phone` **unique and not null**, E.164-normalized by
  the same helper at registration, at the desk, and on change — §6.1/§16; `isProvisional`;
  `phoneVerified` — always `false` in MVP, there is no SMS channel, §6.1). Deliberately **no
  `email`/`emailVerified` here**: the email is on `User` (§6.4 is one global uniqueness rule), so
  a second copy would be a second source of truth for the same identity.
- `DoctorProfile` (1:1 `User`, `verificationStatus` enum
  `INVITED|PENDING_VERIFICATION|VERIFIED|REJECTED|ARCHIVED`, `suspendedAt?`,
  `suspendReason?`, qualification/license/experience/clinicAssociation, free-text
  `specialization`, `consultationFee?` — null falls back to the Clinic default, §3.2/§14).
- `AuthToken` — the **one** generic single-use email token behind §6.2 password reset (link **or**
  OTP), §6.3 registration verification, the §5.1 invite claim, and the §6.1 email change:
  `userId`, `purpose` enum (`EMAIL_VERIFICATION|PASSWORD_RESET|ACCOUNT_CLAIM|EMAIL_CHANGE`),
  `tokenHash` **unique**, `expiresAt`, `consumedAt?`, `createdAt`, `ip?`. Four purposes, one
  model, because it is literally the same mechanic four times; the token is stored **hashed
  (SHA-256)** as with refresh tokens, and the low-entropy case (a 6-digit OTP) is covered by
  §6.3's `auth_attempts` send/try limits, not by the hash.
- **No `StaffProfile` table.** STAFF is a `User.role` value with no staff-specific attributes in
  MVP (§4), and "who did what" is answered by the audit row's actor name snapshot (§5.2, §20).
  A missing table is cheap to add later; attributes scattered into the wrong one are not.
- Migrate + review the generated SQL — including the `Placeholder` table this drops.
- **DoD:** `prisma validate` passes; `prisma migrate reset` on a fresh DB applies cleanly; the
  generated SQL is read line by line (nullability and indexes in particular, since those are the
  parts Prisma expresses indirectly); `db:generate`, `npm run typecheck` and `npm run lint` stay
  green, since regenerating the client touches the types in `src/lib/prisma.ts`.

### Day 5 — Prisma schema: scheduling, appointments, money, audit

Same standard as Day 4: every model written out field by field, because from here the schema is
the contract and an unstated field is a migration later.

- `Schedule` — the weekly template is **one row per window**, not one blob per doctor:
  `doctorId`, `weekday` enum `MON|TUE|WED|THU|FRI|SAT|SUN` (spelling is a convention — §24 fixes the
  field, not the values), `startTime` `@db.Time(0)`,
  `endTime` `@db.Time(0)`, `maxPatients`, unique `(doctor_id, weekday, start_time)`. No
  `effectiveFrom` — §11 makes the **generated slots** the record of what was applied, so a
  template edit touches only dates not yet materialised. No `isActive` — delete the row and audit
  it with the §8.4 reason. A per-doctor blob cannot express two windows in a day.
- `Slot` — `doctorId`, `slotDate` `@db.Date` (clinic-local calendar date, §8.1),
  `startTime`/`endTime` `@db.Time(0)` (clinic-local wall clock), `startAt`/`endAt`
  `@db.Timestamptz(3)` (the same window as UTC instants, **written once at creation** through the
  shared helper — §8.1: every time comparison in the system reads these two fields, never
  server-local time and never the wall-clock columns), `maxPatients`, `bookedCount`, `heldCount`
  (stored counters, never derived — §8.1), `isDisabled` + `disabledReason?`. Unique
  `(doctor_id, slot_date, start_time)` so slot generation and bulk week-create are idempotent
  (§11). The two `CHECK`s and the capacity guard are Day 6, not here.
- `Appointment` — `doctorId`, `patientId` (both → `User`), `slotId`, `status` enum
  `CONFIRMED|ARRIVED|COMPLETED|NO_SHOW|CANCELLED|REJECTED|PENDING` — **`PENDING` is declared for
  forward compatibility and never written** (§13; the §24 enum table is the source for these
  values), snapshots
  `doctorName` + `feeAmount` taken at booking time so a later rename or fee change never rewrites
  what the patient saw or agreed to pay (§14), `bookingTime` (queue position is a **rank** by
  booking time, not a stored counter — §8.1), and `doctorUnavailabilityId?`. That last column is
  the §12 clinic-caused marker — refund classification (§17) and the audit both key off it.
  **No `isClinicCaused` boolean:** it is derived as `doctor_unavailability_id IS NOT NULL`, so the
  two can never disagree — and a disagreement there is a wrongly-refunded or un-refunded patient.
- `SeatHold` — `slotId`, `patientId`, `paymentOrderId?`, `appointmentId?`, `createdAt`,
  `expiresAt` (= `min(now + holdDuration, slot.startAt)`, §8.6), `releasedAt?`, `releaseReason?`
  (`EXPIRED|ABANDONED|PAYMENT_FAILED|CONVERTED|DELETED_WITH_ACCOUNT`). The only trace of an
  unfinished online booking; **never** an `Appointment` row (§8.6, §13).
- `Payment` — `appointmentId?`, `patientId`, `amountPaise` `Int` paise (field `amountPaise` → column
  `amount_paise`, which is the name the raw `CHECK` must use), `currency`, `status` enum
  `PENDING|PAID|FAILED|VOIDED` (never `SUCCESS` — §17), `method`, `orderId?` **UNIQUE** (the §17
  idempotency key, enforced by the database rather than by code), `paymentId?` (kept for
  reconciliation), `paidAt?` (§17).
- `Refund` — `paymentId` **UNIQUE** (the §17 unique refund key: a retried refund or a double-clicked
  approval cannot refund twice), `amountPaise`, `status` enum `PENDING|SUCCESS|FAILED`, `reason`, `actor`,
  `gatewayRefundId?` (null for a desk hand-back), plus the offline hand-back record for pay-at-clinic
  money (§17).
- `AppointmentHistory` / `DoctorHistory` — append-only per-parent timelines (`eventType`, from the
  §24 enum table — `RESCHEDULED` lives here and is **not** an appointment status; `fromStatus`/`toStatus`, `metadata` `Json`). **No `target` columns:** the parent row is the
  target. The shared actor block is the same on both, and on `AuditLog`:
  `actorId` (FK → `User`, `Restrict`) + `actorRole` + `actorName` **snapshot** + `reason` + `ip` +
  `requestId`, with `before`/`after` as `Json` (jsonb) rather than two text columns, because §20
  records arbitrary field sets. The name snapshot is a plain column on purpose: it is what makes a
  later rename or deactivation unable to rewrite attribution (§5.1, §5.2). Append-only tables get
  `createdAt` only, never `updatedAt`.
- `AuditLog` — the actor block above plus `action` as a **`String`** in `SCREAMING_SNAKE`
  (`APPOINTMENT_CAPACITY_CHANGE`), *not* an enum — §20 lists examples, and a closed enum would make
  every new audited action a migration; `targetType` + `targetId` (a polymorphic target, so one table
  covers slot/doctor/appointment/refund writes without a nullable FK to a dozen tables), and a
  mandatory `reason` on the audited actions (§20).
- `Notification` — one row per send: `type` (one value per §18 event, `REMINDER` the only
  plan-named one), `recipient`, `appointmentId?`, **`slotId?`**, `status`
  enum `PENDING|SENT|FAILED`, `sentAt?`, `error?`. `slotId` is required by §18's dedupe key, not
  decoration — see Day 6.
- `DoctorUnavailability` — `doctorId`, `startAt`/`endAt` `@db.Timestamptz(3)`, `reason`,
  `createdById` (→ `User`), audited. The booking transaction re-checks for an overlap inside its
  own transaction (§11), and the §12 cascade and auto-cancel read it.
- `AuthAttempt` — `identifierKey` (the §6.3 identity key: normalised email), `ipKey`,
  `purpose` enum `LOGIN|OTP_SEND|OTP_VERIFY` (§24 table), `succeeded` `Boolean`, `createdAt`, with
  the lookup indexes §6.3's lockout and escalating windows query against.
- `RefreshToken` — `userId`, `tokenHash` **unique**, `expiresAt`, `revokedAt?`, `ip?`,
  `userAgent?`, `createdAt`. No `familyId` (§6.3).
- `[S]` `server/src/lib/time.ts` — the **single** conversion helper (§3.2): the only place that
  builds `startAt`/`endAt`, the only place that formats an instant in clinic-local time, and the
  only place that normalises a phone to E.164. It must **reject a local time that does not exist**
  (spring-forward gap) and take the **first** occurrence of an ambiguous one (fall-back), so a
  02:30 window can never silently become 03:30 or an invalid instant. India has no DST, so this
  will never fire in this clinic — but `APP_TIMEZONE` is configurable, which is exactly how such a
  bug arrives late and unexplained. Implemented by round-trip verification rather than offset
  arithmetic: for every offset the zone could be using, subtract it, format the result back into
  the zone, and keep the candidate that reproduces the requested wall clock — zero matches is a
  gap, two is ambiguous, one is ordinary. **`timeZone` is a required argument with no default**,
  deliberately: this codebase has two timezone values (`APP_TIMEZONE` and `Clinic.timezone`) and
  silently defaulting to one is precisely how a slot gets written in one zone and displayed in
  another. Note that only a leading `+` or `00` marks an international phone number; a bare
  `91-…` is treated as national rather than guessed at, because guessing which reading was meant is
  how one person becomes two rows.
- **DoD:** every entity from `plan.md` §24 exists with the locked enums; `prisma validate` and
  `migrate reset` are clean; the generated SQL is reviewed line by line; `db:generate`,
  `npm run typecheck` and `npm run lint` are green.

### Day 6 — The constraints + seed

**First task of the day is a spike, not a schema edit.** Since Prisma 7.4 the migration engine
reads index predicates back from the database, so a partial index with no matching declaration in
`schema.prisma` is treated as drift and `migrate dev` emits `DROP INDEX` for it — on every run,
even with no schema change ([prisma#29220](https://github.com/prisma/prisma/issues/29220),
[#29289](https://github.com/prisma/prisma/issues/29289)). The workflow §23 mandates for the
partial unique indexes is therefore exactly the workflow that silently deletes the double-booking
guard.

This is **documented Prisma 7 behaviour, not a hypothesis**: `where` is supported on `@unique`,
`@@unique` and `@@index` behind the `partialIndexes` preview feature, with full PostgreSQL support
for migration *and* introspection. The syntax the spike uses:

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  previewFeatures = ["partialIndexes"]
}

// `raw()` is required for the IN-list; the object-literal form
// (`where: { releasedAt: null }`) only expresses equality / IS NULL.
@@unique([patientId, slotId], where: raw("status IN ('CONFIRMED','ARRIVED')"), map: "appointments_active_booking_per_patient_slot_unique")
```

So the spike verifies the **predicate round-trip**, which is the real risk:

- Declare the three partial unique indexes with the exact predicates below, keep the `CHECK`s as raw
  SQL, then run `migrate dev` **three times** and confirm the second and third generate nothing.
- Then run `prisma db pull` and read what comes back. Introspection returns PostgreSQL's
  *normalised* form, so a hand-written `raw("status = 'active'")` reappears as
  `raw("(status = 'active'::text)")`. If the canonical form of our `IN (…)` predicate differs from
  the string we wrote, the differ will keep proposing a change to an index that is already correct —
  a no-op migration loop, which is the same guard-removal bug in a different hat. If it round-trips,
  ship it; if it does not, either write the predicate in PostgreSQL's normalised form or take the
  `active_marker` fallback.
- Fallback: a maintained `active_marker` column (NULL when released, a constant when live) plus
  `@@unique([patientId, activeMarker])` with `NULLS NOT DISTINCT` — PostgreSQL 18.3 has it, it
  carries no predicate, so Prisma owns the index and can never drop it.
- Also confirm `CHECK` constraints are neither introspected nor dropped, since Prisma has no
  `CHECK` support at all.

Then write the constraints — **this is not optional; they are the double-booking guard**, and the
spelling is **snake_case column names**, because these are raw SQL against the mapped columns:

| Constraint | Table | Mechanism |
|---|---|---|
| `UNIQUE (patient_id) WHERE released_at IS NULL` — one live hold per patient | `SeatHold` | per spike |
| `UNIQUE (patient_id, slot_id) WHERE status IN ('CONFIRMED','ARRIVED')` — one active booking per patient per slot | `Appointment` | per spike |
| `UNIQUE (appointment_id, slot_id) WHERE type = 'REMINDER'` — a reminder is never sent twice (§18) | `Notification` | per spike |
| `CHECK (booked_count + held_count <= max_patients)` and `CHECK (max_patients > 0)` | `Slot` | raw SQL |
| `CHECK (amount_paise > 0)` | `Payment` | raw SQL |

The reminder index is keyed on `(appointment_id, slot_id)` **including the slot** on purpose: after
a §14 reschedule the appointment's slot changes, so a key of `(type, appointment_id)` alone would
reject the reminder for the new time — the patient would silently stop being reminded. No other
notification type is constrained; §18 locks only the reminder.

- `[T]` Assert in a scratch script (`server/scripts/`, run with `tsx` — Vitest does not arrive until
  Day 35) that the database **rejects** each violating write: an over-capacity update, a second
  active same-slot booking, a second live hold per patient, a second reminder for the same
  appointment+slot, and a non-positive payment amount. A passing ORM migration is not evidence that
  these rules exist.
- `[T]` Assert the §8.1 derived-instant rule: for every seeded slot,
  `start_at == toUtc(slot_date, start_time, clinic.timezone)`. Nothing in the database enforces
  this, and every time comparison in the system depends on it.
- Seed script at `server/prisma/seed.ts`, wired through `migrations.seed` in `prisma.config.ts`
  (v7 removed `--skip-seed`, so this config entry **is** the hook). Idempotent — re-runnable
  without duplicating. Clinic config, one admin, two verified doctors, one staff, two patients,
  this week's slots.
- **Seeded credentials, decided (was open, now locked):** the admin, doctors and staff are created
  with `passwordHash = null` — no dev-only password, no env-gated second door. §5.1's rule is that
  no one ever hands over a credential, and a "dev password" is just the seeded `admin/admin123` that
  reaches a real clinic three months later; a second way into an authenticated account is a
  production risk dressed as a convenience. Log in as them through the §6.2 claim link that Day 7's
  stub prints, which also means the claim flow is exercised every day instead of being discovered
  broken at hand-off. The cost is four clicks per fresh `dropdb → seed`, and nothing needs a login
  before Day 7 anyway. The idempotent seed must never overwrite a claimed `passwordHash` (upsert on
  the key columns, no field-level update of `passwordHash`).
- **The two seeded patients are the exception: they get a real bcrypt hash**, because a patient
  account is a self-registered account that always has a password (§5.1), and a patient row with a
  null hash would be an account nobody can ever log into. The password comes from
  `SEED_PATIENT_PASSWORD` in the environment — never hardcoded in the seed, never committed, and
  `.env.example` carries a placeholder so the failure is "set the var", not "seed threw".
- **The owner email is an input, not a constant:** §5.1 says the bootstrap reads the clinic owner's
  email from environment configuration, so Day 4 adds `CLINIC_OWNER_EMAIL` to `.env.example` and the
  config schema, and the seed creates the admin against it. Keep it out of the fixture as a literal —
  a hardcoded address becomes the first admin of whoever runs the seed.
- **DoD:** `dropdb → migrate → seed` reproduces a working DB; every constraint above is proven by a
  failing write; a second `migrate dev` with no schema change produces **no** migration; the seed
  logs which mode it ran in (`null hash, claim via reset link` vs `seeded password`), so nobody has
  to guess why a login failed.
- §24 also lists a second `SeatHold` index, `UNIQUE (slot_id, patient_id) WHERE released_at IS
  NULL`; the one-live-hold-per-patient index above already implies it. Settle it during the spike:
  ship it as belt-and-braces, or drop it as redundant.
- **Phase 1 complete.**

---

## Phase 2 — Auth and RBAC (Days 7–11)

The biggest server phase. Do it fully before touching scheduling. §3.4: every rule server-side.

### Day 7 — Registration + email verification
- `[S]` Patient register (email + password, bcrypt). Account starts `EMAIL_UNVERIFIED`.
- `[S]` Email verify via one-time link/OTP (Resend stub for now — real send in Phase 7;
  log the link to console until then). Booking blocked until verified (§6.3).
- `[S]` Global email uniqueness enforced at every entry point (§6.4).
- `[C]` Register + verify screens.
- **DoD:** can register, receive/see a verify link, and are blocked from booking until verified.

### Day 8 — Login, access + refresh tokens
- `[S]` Login → short-lived JWT access (15 min) + opaque refresh token stored **hashed
  (SHA-256)** in `refresh_tokens`. Refresh rotates and revokes the previous (§6.3).
- `[S]` HTTP-only cookie for the refresh token; access token in memory/header.
- `[S]` `/auth/refresh` and `/auth/logout`. Presenting a revoked refresh token fails.
- **DoD:** login → access API → refresh rotates → logout revokes → old refresh fails.

### Day 9 — Security hardening
- `[S]` DB-backed `auth_attempts` rate limiting: 5 email failures → 15-min lockout, IP cap,
  OTP send/try limits, escalating lockout, generic 429 (§6.3).
- `[S]` Per-request status re-check for DOCTOR/STAFF/ADMIN (suspension/deactivation takes
  effect immediately, not at token expiry).
- `[S]` "Revoke every session" as one statement — wire into password reset + deactivation.
- `[T]` Lockout, rotation, and immediate-revocation tests.
- **DoD:** suspending a doctor logs him out everywhere on the next request.

### Day 10 — RBAC + ownership
- `[S]` Role middleware for all four roles. Ownership checks (patient sees only their data;
  doctor sees only their own schedule). §7.
- `[S]` Bootstrap first admin via a setup command (no admin self-registration).
- **DoD:** each role can only reach its own endpoints; a patient cannot reach a doctor's.

### Day 11 — Forgot password + account management
- `[S]` Forgot password (email reset link or OTP) → set new password → revoke all sessions.
- `[S]` Patient account: update email/phone (verify new email), delete → anonymise.
- `[C]` Forgot/reset + profile + delete-account screens.
- **DoD:** full account lifecycle works; a reset kills all sessions.
- **Phase 2 complete.**

---

## Phase 3 — Doctor & Clinic Management (Days 12–14)

### Day 12 — Doctor onboarding + verification (backend)
- `[S]` Invite/claim flow (admin→staff, admin/staff→doctor) (§5.1).
- `[S]` Doctor CRUD by admin; staff may create/update/suspend/archive but **not** verify,
  un-archive, un-suspend (§5.2, admin-only).
- `[S]` Verification state machine (`INVITED→PENDING_VERIFICATION→VERIFIED/REJECTED`,
  `ARCHIVED`, orthogonal suspend). Credential edits force re-verification; a profile edit
  on an `ARCHIVED` doctor is rejected (§5.2).
- **DoD:** the §5 transition matrix is enforced; role limits hold.

### Day 13 — Public doctor surface
- `[S]` Public list + profile endpoints (verified doctors only; suspended hidden).
- `[C]` Landing page, public doctor list, specialization browse, doctor cards, booking
  entry points (§26).
- **DoD:** a verified doctor appears publicly; a suspended one does not.

### Day 14 — Doctor dashboard foundation
- `[C]` Doctor shell: profile edit (triggers re-verification), schedule placeholder, today's
  appointments, read-only live queue (name + masked contact + status, "up next") (§28).
- **DoD:** doctor can view/edit own profile and see today's queue read-only.
- **Phase 3 complete.**

---

## Phase 4 — Scheduling Engine (Days 15–18)

### Day 15 — Schedule + slot generation
- `[S]` Schedule template CRUD (working days, window start/end, `maxPatients`).
- `[S]` Materialize dated `Slot`s from the template across the 60-day horizon; idempotent
  (unique `doctorId+slotDate+startTime`) (§11).
- **DoD:** creating a schedule produces correct slots; re-running doesn't duplicate.

### Day 16 — Slot management + capacity + horizon
- `[S]` Slot create/edit/disable with the §8.4 guards: block date/time edits and
  disable/remove while the slot still holds a seat or a live hold; capacity-only edits
  allowed, always with a reason (audited).
- `[S]` Booking horizon + cutoff settings from the single `Clinic` config (§3.2).
- **DoD:** the guard rejects a booked-slot time edit with a clear error; a capacity raise
  is audited.

### Day 17 — Availability read model
- `[S]` "Bookable slots for doctor X on date D" endpoint — hides suspended/unverified
  doctors, closed slots, full slots, and slots overlapping `DoctorUnavailability` (§11).
- `[C]` Slot picker on the doctor profile / patient dashboard.
- **DoD:** patient sees only genuinely bookable slots.

### Day 18 — Unavailability
- `[S]` Staff/admin/doctor mark unavailability; affected slots close; existing confirmed
  appointments cascade (notify, waive cutoff, auto-cancel + auto-refund) (§12).
- `[T]` "Attendance is never overwritten" — a `COMPLETED`/`NO_SHOW` patient is not
  auto-cancelled.
- **DoD:** marking a doctor unavailable closes slots and cleanly cascades bookings.
- **Phase 4 complete.**

---

## Phase 5 — Appointment Engine (Days 19–22)

The correctness-critical phase. Slow down here.

### Day 19 — Booking (pay-at-clinic path first)
- `[S]` Book a slot → `CONFIRMED` appointment. Guarded update: `booked + held < maxPatients`
  inside a transaction, `SELECT … FOR UPDATE` on the slot (§15).
- `[S]` Per-patient caps: max 3 active bookings, one active booking per slot (partial unique
  index). Queue position = rank by `bookingTime` (no stored counter) (§8.1, §15).
- `[C]` Confirm-booking flow (no payment yet).
- **DoD:** two people race for the last seat — exactly one wins; no overbooking.

### Day 20 — Concurrency + audit
- `[S]` Double-booking/overbooking tests hammering the last seat (§15, `[T]`).
- `[S]` `AuditLog` on every state change; `AppointmentHistory` timeline written.
- **DoD:** concurrency tests green; every booking/cancel/transition is audited + in history.

### Day 21 — Status transitions + attendance
- `[S]` Enforce the §13 matrix server-side (terminal states; no `COMPLETED` directly from
  `CONFIRMED`; `NO_SHOW` only after `endAt`; `REJECTED` needs a reason).
- `[S]` Check-in (`ARRIVED`) and `COMPLETED`/`NO_SHOW`, admin/staff only.
- `[S]` Patient cancel (before cutoff) and the §12 auto-cancel job.
- **DoD:** illegal transitions are rejected; check-in flow works.

### Day 22 — Rescheduling
- `[S]` Reschedule = same row, new slot (never a `RESCHEDULED` status). Enforce cutoff +
  capacity; higher fee → payment before commit; lower fee → automatic refund (§14).
- **DoD:** reschedule moves the appointment, writes a `RESCHEDULED` history event, and
  settles any fee delta.
- **Phase 5 complete.**

---

## Phase 6 — Payments (Days 23–26)

### Day 23 — Razorpay order + client checkout
- `[S]` Create order (fee from §3.2/§24; check against the booking-time `feeAmount`
  snapshot). `[C]` Razorpay checkout UI.
- **DoD:** an order is created and the checkout opens.

### Day 24 — Seat hold + conversion
- `[S]` **Seat hold** before payment: create `SeatHold` + `PENDING` payment, 10-min expiry
  = `min(now+10min, slot.startAt)`; the seat is held, not booked (§8.6).
- `[S]` Webhook + verify → one transaction: hold→`CONVERTED`, seat `held→booked`,
  `Appointment` created `CONFIRMED`, `Payment`→`PAID` (§17 step 5).
- **DoD:** paying converts the hold into exactly one confirmed appointment.

### Day 25 — Failure, idempotency, refunds
- `[S]` **Any** step-5 rejection after payment → no appointment + full auto-refund, per
  cause (§17). `[T]` Each cause asserted: no appointment, `Payment` stays `PAID`,
  `Refund`→`SUCCESS`, seat freed.
- `[S]` Idempotency: `PENDING→PAID` once; a retried webhook/conversion is a no-op (§17).
- `[S]` Auto-refund the clear cases (clinic-caused, in-window cancel, cheaper reschedule,
  conversion failure); queue only disputes (after-cutoff contested, no-show dispute,
  amount dispute, gateway-failed retry) (§17).
- **DoD:** every refund scenario behaves per §17 and notifies the patient (Phase 7).

### Day 26 — Pay-at-clinic + offline hand-back
- `[S]` Record offline payment; desk voids unpaid; the auto-cancel job closes out the
  remaining `CONFIRMED` after the slot (§17).
- `[S]` Cash/UPI hand-back recorded against the refund (staff dashboard, no gateway).
- **DoD:** the whole non-online money path works end-to-end.
- **Phase 6 complete.**

---

## Phase 7 — Notifications (Days 27–29)

### Day 27 — Notification service
- `[S]` Resend integration + `Notification` row per send (`type`, `recipient`, `status`,
  `sentAt`, provider error). A send must never block an HTTP request — fire from the
  service, not inline (§18).
- `[S]` Wire the auth/account emails (verification, reset, invites, security notice).
- **DoD:** every auth email sends and is logged.

### Day 28 — Appointment + payment emails
- `[S]` Booking confirmation (fires at payment verification), cancelled, rescheduled,
  rejected, doctor-unavailable, auto-cancelled, payment receipt, every refund completion.
- **DoD:** each event produces the right logged email.

### Day 29 — Reminders + in-process jobs
- `[S]` In-process interval scheduler (no queue, no Redis): the **2-hour** reminder, hold
  expiry, the §12 auto-cancel, slot generation. The **hold-expiry sweep runs once at
  startup before serving traffic** (§8.6, §18).
- `[S]` Dedupe: a reminder is never sent twice (the `Notification` row is the key); a
  failed send is visible.
- **DoD:** booking → reminder fires once at T-2h; re-running the job doesn't double-send.
- **Phase 7 complete.**

---

## Phase 8 — Dashboards & UI (Days 30–34)

### Day 30 — Patient dashboard
- `[C]` Upcoming/past appointments, cancel, reschedule, payment info, profile. Fetch with
  TanStack Query; loading/error/empty states throughout.

### Day 31 — Doctor dashboard
- `[C]` Today's schedule, availability editor, mark unavailable, read-only live queue.

### Day 32 — Staff dashboard (front desk)
- `[C]` Today's slots + queue, check-in, mark completed/no-show, create walk-in booking
  (provisional patient), record offline payment, staff refund hand-backs, visit-history
  lookup, slot/capacity/unavailability management.

### Day 33 — Admin dashboard
- `[C]` Stats, doctor management + verification, patients, appointments, attendance,
  schedule/slot/capacity, refund dispute queue, payments, notifications, audit log.

### Day 34 — Walk-ins, polish, accessibility
- `[C]` Wire the provisional/walk-in path end-to-end; responsive pass; form validation
  (Zod + RHF shared with the server schemas); a11y basics (labels, focus, contrast).
- **Phase 8 complete.**

---

## Phase 9 — Testing & hardening (Days 35–38)

Not a phase you defer — this is where you prove the hard rules. Mirror `plan.md` §33.

### Day 35 — Test harness
- Vitest + Supertest in `server/`; a test DB helper (fresh migrate per run); arrange
  factories for clinic/doctor/patient/slot.

### Day 36 — Auth + authorization tests
- Lockout, rotation, immediate revocation, email uniqueness across entry points, RBAC +
  ownership per role.

### Day 37 — Business-rule + concurrency tests
- Booking/overbooking races, same-slot duplicates, cutoff boundaries, reschedule fee delta,
  the §13 matrix (all illegal transitions), the three DB constraints, and **every** step-5
  rejection → no appointment + auto-refund.

### Day 38 — Security + review sweep
- Review against §33's list: payment enum discipline (`SUCCESS` only on `Refund`),
  audit append-only, ownership on every route, error handling, logging, DB constraints.
  Walk the §38 completion criteria end-to-end.
- **Phase 9 / MVP complete.** 🎉

---

## Reality check

This is roughly **38 focused days** (~4–6 hrs/day) for a **solo** developer. That is honest
for a system with auth + payments + scheduling + notifications + three dashboards + real
concurrency safety. The two phases most likely to overrun are **Phase 2 (auth)** and
**Phase 6 (payments)** — the money and security paths deserve the time.

**If you need it smaller, cut in this order (all already deferred in `plan.md`):**
1. Pay-at-clinic only — drop online Razorpay first (largest single saving, §42).
2. Drop the doctor dashboard to read-only.
3. Ship one reminder only (already the case) and skip the reminder tuning.

**Do not cut:** the seat-hold + guarded-capacity booking path, the step-5 auto-refund, the
DB constraints, the audit log, or the RBAC/ownership checks. Those are what keep the
clinic's money and data correct — they are the reason this build is safe to hand to a real
clinic, and they are not the complex-for-complex's-sake kind of complexity.

**Suggested order to actually start:** begin at **Day 1**. The foundation phase is the
least glamorous and the most load-bearing — once `/health` proves the DB round-trips on
Day 3, every later phase is just building on a working spine.
