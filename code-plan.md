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
  `JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`, `RESEND_API_KEY`, `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `CLIENT_URL`, `APP_TIMEZONE` (§35).
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
  `postgres`: `CREATE ROLE doctor_booking LOGIN PASSWORD '…';` then
  `CREATE DATABASE doctor_booking OWNER doctor_booking;`.
- `[S]` Prisma 7 is ESM-only, so convert `server/` to ESM: `"type": "module"`,
  tsconfig `module: ESNext` / `moduleResolution: bundler`, and `.js` extensions on
  relative imports. Stay on **7.x**; 8.x is still RC.
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
- `Clinic` (single row, config record, `defaultConsultationFee`, `currency`, `timezone`).
- `User` (`role` enum `PATIENT|DOCTOR|STAFF|ADMIN`, `email` **unique**, `passwordHash`
  non-null, `phone`, `emailVerifiedAt`, `isDeactivated`). No OAuth, no `Department`.
- `PatientProfile` (1:1 `User`, `isProvisional`, `fullName`, `phone`).
- `DoctorProfile` (1:1 `User`, `verificationStatus` enum
  `INVITED|PENDING_VERIFICATION|VERIFIED|REJECTED|ARCHIVED`, `suspendedAt?`,
  `suspendReason?`, qualification/license/experience/clinicAssociation, free-text
  `specialization`, `consultationFee?`).
- Migrate + review the generated SQL.
- **DoD:** migration applies cleanly on a fresh DB.

### Day 5 — Prisma schema: scheduling, appointments, money, audit
- `Schedule` (weekly template: doctor, working days, `maxPatients`).
- `Slot` (`doctorId`, `slotDate`, `startTime`/`endTime`, derived `startAt`/`endAt`, `maxPatients`,
  `bookedCount`, `heldCount`).
- `Appointment` (`doctorId`, `patientId`, `slotId`, status enum
  `CONFIRMED|ARRIVED|COMPLETED|NO_SHOW|CANCELLED|REJECTED`, snapshot `doctorName` +
  `feeAmount`, `bookingTime` for queue rank). No `PENDING` status.
- `AppointmentHistory` (append-only: from/to, eventType, actor, metadata).
- `SeatHold`, `Payment`, `Refund` (enums exactly per §17), `Notification`, `AuditLog`,
  `DoctorHistory`, `DoctorUnavailability`, `AuthAttempt`, `RefreshToken`.
- **DoD:** every entity from `plan.md` §24 exists with the locked enums.

### Day 6 — The three hand-written constraints + seed
- The 2 partial unique indexes + the `CHECK (bookedCount + heldCount <= maxPatients)` that
  Prisma can't express — write them as a reviewed SQL migration after `migrate dev`
  (§23). This is **not optional**; they are the double-booking guard.
- `[T]` Assert in a scratch script that the DB rejects a violating write (over-capacity
  update, second active same-slot booking, second live hold per patient).
- Seed script: clinic config, one admin, two verified doctors, one staff, two patients,
  this week's slots. Idempotent (safe to re-run).
- **DoD:** `dropdb → migrate → seed` reproduces a working DB; all three constraints proven
  by a failing write.
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
