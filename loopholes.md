# Loopholes — CLOSED

**Status: every open item is resolved. Nothing is outstanding.**

This file is kept as the audit trail for the loophole review, not as a work list. The
authoritative specification is `plan.md`; every fix below is already synced there.

How items were classified:

- **Real contradiction** — a developer following `plan.md` literally would build the
  wrong thing, or two sections would demand opposite behaviour. These were fixed in the
  plan text.
- **Stale sentence** — the plan's *decision* was already correct but a summary, test list,
  acceptance criterion, phase list, or `§42` backlog still described the older design.
  Fixed by sweeping those references.
- **Not a loophole** — decidable while coding, already handled elsewhere in the plan, a
  false premise, or a deliberate non-MVP deferral. Recorded with a reason, not "fixed".

Three independent audit passes were run over the whole plan. The first pass produced 26
candidate items; the second pass caught 7 high-severity contradictions plus 6 medium ones
that the first sweep had introduced or left behind; the final pass was clean.

---

## 1. Real contradictions that were fixed

| ID | Contradiction found | Resolution in `plan.md` |
|---|---|---|
| A1 | Doctor lifecycle was unspecifiable: "potential states", an "onboarding" step with no target state, and a deferred "rejected vs suspended" decision | Locked one enum `INVITED / PENDING_VERIFICATION / VERIFIED / REJECTED / ARCHIVED` plus orthogonal `suspendedAt` / `suspendReason` (§5) |
| A2 | Editing a slot's date/times or disabling it silently moved or destroyed booked patients' appointments | Blocked while the slot still holds a seat (`CONFIRMED`/`ARRIVED`, or `COMPLETED`/`NO_SHOW` on a not-yet-ended slot) or a live hold; capacity-only edits stay allowed, always with a reason (§8.4) |
| A3 | Suspending a doctor did not say what happened to their future bookings, and a future-dated "offboarding" was implied but never specified | Immediate suspension/archive cascades an automatic cancel + automatic refund, notifies patients, waives the cutoff, revokes sessions, and rejects concurrent bookings (§5.2, §12) |
| A4 | Walk-in patients were unbuildable: booking required an email, a verified account, and a login | Provisional patient records: phone-matched, `isProvisional`, no login, exempt from email verification, pay-at-clinic, visible in staff views (§16) |
| A5 | Refund outcomes were undefined, so "refund failed" and "no refund" were indistinguishable | `Payment.status = PENDING / PAID / FAILED / VOIDED`, `Refund.status = PENDING / SUCCESS / FAILED`; money in paise; `SUCCESS` is refund vocabulary and never a payment state (§17) |
| A6 | The idempotency rule said a retry after payment "re-reads the appointment" — but no appointment exists until the hold converts | Retry is a no-op that returns the original result; the only legal transition is `PENDING → PAID`; a retried conversion re-uses the same hold and produces the one `CONFIRMED` appointment (§17) |
| A7 | If a booking failed *after* a successful payment, the seat, the payment and the patient were left in an unknown state | Any step-5 conversion failure produces no appointment and a full automatic refund, asserted per cause against the real database (§17, §33) |
| B1 | `ARCHIVED` was declared terminal while un-archiving moved the doctor to `VERIFIED` | `ARCHIVED` is terminal for every normal transition; the audited ADMIN-only un-archive path is named as the single exception, with a justification for landing on `VERIFIED` (§5, §5.2) |
| B2 | The §13 terminal-states sentence was malformed and listed `ARCHIVED` — a doctor value — among appointment statuses | Terminal appointment states are `COMPLETED`, `NO_SHOW`, `CANCELLED`, `REJECTED`; no "undo cancel" in MVP, with the reason stated (§13) |
| B3 | The §8.4 date/time-edit guard covered bookings but not live holds, while the adjacent disable guard covered both | Both guards use the same "seat or hold" test; the hold case is explained via `expiresAt = min(now + 10 min, slot.startAt)` (§8.4) |
| B4 | §17 step 5 said the queue position came "from the value the same update returned", but the SQL had no `RETURNING` and `booked_count` is a seat total, not a position | The queue position is a rank derived from booking time; the update moves seat counts only (§8.1, §17) |
| B5 | §17 claimed every step-5 failure was covered by a §33 test that did not exist | §33 now enumerates all four causes and asserts no appointment, `Payment` stays `PAID` with a `Refund` reaching `SUCCESS`, and the seat is free (§33) |
| B6 | The cheaper-reschedule refund had no home in §17's closed enumeration of refund cases | Added to §17's refund table and to the automatic-refund list, computed against the booking-time `feeAmount` snapshot (§14, §17) |
| B7 | Payment states were written as `CLOSED` in one section and `VOIDED` in another | One enum; `VOIDED` is used everywhere and the earlier ambiguous `CLOSED` is explicitly rejected (§17) |
| C1 | §33/§38 described every refund as "create request → admin approves", contradicting the automatic/queue split | All four §33 and both §38 sites restated as automatic vs contested (§33, §38) |
| C2 | An after-cutoff cancellation was auto-refunded in one place and non-refundable in another, and §33 stated the rule unconditionally | Default is no refund; a refund request exists only if the patient contests it — stated identically in §17, §33 and §38 (§17, §33, §38) |
| C3 | `un-suspend`/`un-archive` were granted to STAFF in §4 while §5.2, §29 and §33 made them ADMIN-only | §4 now names verify, un-archive and un-suspend as ADMIN-only, matching §5.2/§29/§33 (§4) |
| C4 | A STAFF profile edit on an `ARCHIVED` doctor would flip it to `PENDING_VERIFICATION`, a profile action moving it out of a terminal state | Any profile edit of an `ARCHIVED` record is rejected; only the audited un-archive path restores it (§5.2) |
| D1 | §8.4 treated "active bookings" as `CONFIRMED`/`ARRIVED` only, while §8.1 says `COMPLETED`/`NO_SHOW` also keep the seat | Guards now use "still holds a seat", covering not-yet-ended `COMPLETED`/`NO_SHOW` (§8.1, §8.4) |
| D2 | §12/§38 assigned slot creation, capacity change and unavailability to roles that do not hold those permissions | Restated as staff-or-admin, matching §4 and §29 (§38) |
| D3 | The doctor model put `specialization` on `User` in §24 while §30 defines it as a doctor-profile field | Moved to `DoctorProfile` in §24, alongside the other verification-impacting fields (§24, §30) |
| D4 | The `heldCount` bookkeeping was described as provably equal to live holds, which an expired-but-unreleased hold disproves | Correctness is enforced by in-transaction time re-checks; a hold-expiry sweep runs on an interval **and at startup before traffic**; `heldCount` is explicitly a lower bound, never authoritative (§8.6, §18) |
| D5 | Prisma cannot express the two partial unique indexes or the `CHECK` constraints, and the plan never said so | §23 now requires a hand-written SQL migration and lists all three, with §33 asserting each against the real database (§23, §33) |
| D6 | A completed refund never told the patient, and almost all MVP refunds are automatic | Every refund reaching `SUCCESS` notifies the patient with amount and reason, emitted by the refund path itself (§18) |
| D7 | The desk hand-back task was assigned to STAFF but listed only on the admin dashboard, and the admin dashboard explicitly excluded it | Hand-backs are on the staff dashboard; admin sees only disputes and retried gateway refunds (§4, §17, §29) |

---

## 2. Stale sentences that were swept

| # | Stale text | Where | Resolution |
|---|---|---|---|
| 1 | Three-reminder sequence | §18, §33, §37, §38 | One reminder, 2 h before slot start, with a dedupe assertion |
| 2 | Refresh-token family / reuse detection, "session-theft alert" | §6.3, §18, §24, §42 | Rotation + immediate session revocation kept; family detection, the alert and the session-listing screen deferred (§42) |
| 3 | Google OAuth | §6, §6.4, §42, §45 | Email + password for all roles |
| 4 | `Department` entity | §30, §42, §45 | Free-text `specialization` on `DoctorProfile` |
| 5 | Scheduled / future-dated offboarding (`scheduledAction`, `effectiveAt`) | §4, §5.2, §38, §42 | Removed; suspension and archive are immediate |
| 6 | Database `GRANT`/`REVOKE` audit immutability | §5.2, §20, §38, §42 | Removed; append-only by convention and test. §41 was the wrong citation — repointed to §42 |
| 7 | "Authorized capacity override" | §8.3, §15, §20, §33, §37 | No override concept; a deliberate `maxPatients` raise with an audited reason |
| 8 | Appointment `PENDING` status | §13, §15, §24 | Never written; an appointment is born `CONFIRMED` |
| 9 | `RESCHEDULED` as a status in the transition matrix | §13 | Removed — a reschedule keeps the same row `CONFIRMED` and writes a history event |
| 10 | `SYSTEM` missing from the transition matrix's actor column | §13 | Added, for the §12 auto-cancel job |
| 11 | Duplicated "admin verifies doctor" flow step | §5 | Steps renumbered 1–5 |
| 12 | `bookedCount` "including holds via `heldCount`" | §8.1 | `bookedCount` excludes holds; fullness is `bookedCount + heldCount = maxPatients` |
| 13 | Queue positions "never renumbered" *and* "the queue closes up" | §8.1 | One rule: rank from booking time, so no renumbering logic and no position column |
| 14 | `startAt`/`endAt` "written at creation" vs "derived" | §8.1, §24 | Derived from date + time and stored |
| 15 | Undefined background job called "the sweep" | §33 | The hold-expiry sweep, named and defined in §8.6/§18 |
| 16 | "Appointment booked" and "Appointment confirmed" as two events | §18, §33, §37 | One event — an appointment is born `CONFIRMED` |
| 17 | Offline auto-refund shown in the admin queue | §17 | Pay-at-clinic hand-backs are a staff-settlable task, outside both the auto list and the dispute queue |
| 18 | `slotEndAt` | §33 | `endAt`, as everywhere else |
| 19 | Stale `Pending:` note deferring the fee decision to a deleted loophole item | §14 | Fee is locked in §3.2 and §24; the order is checked against it in §17 |
| 20 | Editorial placeholder "(see where users see and revoke their own devices)" | §42 | Written out as the session-listing screen, deferred |
| 21 | Missing §42 entries for six deferred features | §42 | A "Deferred out of MVP by explicit decision" list now covers all six |
| 22 | `§41` cited for GRANT/REVOKE hardening, which §41 never mentions | §5.2, §20 | Repointed to §42 |
| 23 | `specialization` on `User` | §24 | On `DoctorProfile` |
| 24 | `User.passwordHash` "nullable for Google users" | §5.1, §24 | **Nullable — but never for OAuth.** There are no OAuth users (§6); the null hash is the normal "provisioned but not yet claimed" state, because §5.1 forbids a temporary password and every admin/doctor/staff account claims its password through the §6.2 reset flow. A null hash must always fail login (§24) |
| 25 | `DoctorVerification` entity | §24 | Removed; the decision is a `verificationStatus` + `DoctorHistory` + `AuditLog` |
| 26 | Scope-cuts and one-refund/simplified-reminders recorded as pending decisions | §42, §30, §18 | Applied; recorded here as decisions taken |

---

## 3. Items that were never loopholes

These were investigated and dismissed. They are listed so nobody re-raises them.

| Item | Why it is not a loophole |
|---|---|
| Fee amount is not defined | **False premise.** `consultationFee` and `feeAmount` were already specified (§24) with a clinic default (§3.2) and a booking-time snapshot (§14) |
| Suspending and un-suspending a doctor "needs thought" | Now fully specified: orthogonal `suspendedAt`, restore-preserves-lifecycle, and one transaction (§5) |
| Refresh token vs JWT choice | Not a design question; both are used, each for its purpose (§6.3) |
| "Simple hash instead of bcrypt" | A quality decision, not an ambiguity; bcrypt is locked (§45) |
| Unique constraint on `PatientProfile.email` | Not a loophole, but the premise was wrong: there is no `PatientProfile.email` — the email (and its verification flag) lives once on `User`, and §6.4's uniqueness rule is global. `PatientProfile` holds only the unique normalized `phone` (§24) |
| Login attempt lockout/rate-limiting | MVP accepts the risk; no rule is left undefined (§42) |
| Patient cannot re-register and orphan their history | Blocked by the global unique email (§6.4) |
| Booking twice in the same slot | Blocked by a partial unique index plus a pre-payment check (§15) |
| Queue position gaps after cancellation | Impossible by construction — the position is a rank, not a stored counter (§8.1) |
| Duplicate refund on a retried webhook | Blocked by payment-order idempotency (§17) |
| Timezone drift between server and clinic | One UTC store, one `Clinic.timezone` for display (§3.2) |
| Fee changing between booking and payment | Snapshot on the appointment; the order is checked against the snapshot (§14, §17) |
| `Clinic` being an entity at all | A deliberate modelling choice for a single-clinic app, with settings in one record (§3.2) |
| No clinic admin / no multi-tenancy | Deliberate: one internal clinic (§42) |
| Password reset needs a "change password" screen | Part of any auth flow; not a spec gap |
| Session list / "log out everywhere" | Kept the immediate revocation; deferred the listing screen (§42) |
| Soft deletes for `PatientProfile` | Rejected: anonymisation on delete was chosen instead, so a deleted user is a real absence (§6.1) |
| Walk-in patients need a full account | Resolved by the provisional-patient path (§16) |
| Provisional patient claiming | Deferred explicitly (§42) |
| Notification failure handling | Resolved: `FAILED` + provider error on the `Notification` row (§18) |
| In-process jobs losing reminders on restart | Accepted and stated: a missed window is a missed reminder, not a late one (§18) |
| A3 duplicate-claim and suspension-duplicate test bullets | Near-identical but distinct scenarios; kept both |

---

## 4. Scope decisions taken (not loopholes)

The review was asked whether the plan was too complex. These are the simplifications
chosen, and each is now stated in `plan.md`:

| Decision | Outcome |
|---|---|
| Online payments | **Kept** — realistic for a clinic, and payment handling is where real bugs cost money |
| Doctor verification | **Kept** — a verified badge is a safety claim, so the state machine is specified |
| Refund workflow | **Simplified** — auto-refund every clear case (clinic-caused, in-window, cheaper reschedule, conversion failure), queue only genuine disputes |
| Google OAuth | **Removed** |
| `Department` entity | **Removed** — free-text `specialization` |
| Scheduled offboarding | **Removed** |
| Refresh-token family / reuse detection | **Removed** — rotation and immediate revocation kept |
| Reminder schedule | **Reduced to one** reminder, 2 h before, with dedupe |
| Job infrastructure | **In-process timers**, no queue, no Redis (§18, §42, §43) |
| DB-level audit grants | **Removed** — append-only by convention and test |

---

## 5. State of the plan

- `plan.md` contains no open contradiction, no stale reference to a removed feature, and
  no undefined term.
- Every §-cross-reference resolves to the section it claims.
- Every table parses; the §13 transition matrix has no duplicate rows.
- `Payment` is never written `SUCCESS` or `CLOSED`; `SUCCESS` belongs to `Refund` only.
- Three constraints Prisma cannot express are called out in §23 as a required hand-written
  SQL migration, with §33 asserting each one against the real database.

**Nothing is outstanding. `plan.md` is the specification; this file is history.**

---

## 6. Addendum — schema decisions locked at the Phase 1 kickoff (Days 4–6)

Six questions surfaced while reading Day 4 of `code-plan.md` against `plan.md`, and nine more
while specifying Days 5 and 6. None was a loophole in the plan — they were places where the
execution guide and the specification disagreed, or where the plan was silent. Each is now stated
in `plan.md` (§3.2, §18, §23, §24) and in `code-plan.md` Days 4–6.

### 6a. Identity and clinic (Day 4)

| Question | Decision | Why |
|---|---|---|
| Is `User.passwordHash` nullable? | **Yes** | §5.1 forbids a temporary password, so a provisioned account has no password until it is claimed through the §6.2 reset flow. `null` *means* "not claimed yet" and must always fail login. The earlier "non-nullable because there are no OAuth users" resolution (item 24) reasoned from the wrong premise and is corrected above |
| Where does the phone number live? | **`PatientProfile.phone` only** | It is patient identity data (§16). `User` has no `phone`, so the desk lookup has one key instead of two columns that can disagree |
| Where does email verification live? | **`User.emailVerifiedAt` only** | §6.3's verification applies to one account, and §6.4's uniqueness rule is global, so a per-profile `email`/`emailVerified` pair would be a duplicate source of truth. `pendingEmail` holds an unverified change (§6.1) |
| Is there a model for the email OTP/link tokens? | **Yes — one `AuthToken`** | §6.2, §6.3, §5.1 and §6.1 are the same mechanic four times, and the plan listed no entity for it. It is added in Phase 1 because the schema is the contract from here on; finding out in Phase 2 would mean a migration to add a table everything already depends on |
| How are columns spelled? | **Prisma `camelCase`, PostgreSQL `snake_case` via `@map`** | The plan already wrote the guarded `UPDATE slots SET booked_count …` in snake_case (§15) but the index definitions in camelCase, so a hand-written `CHECK` written against a camelCase name would create no constraint at all. Fixed once, on the first real schema, before the Day 6 SQL migrations inherit it |
| Is there a `StaffProfile` table? | **No** | STAFF has no attributes beyond its `User` row, and attribution is answered by the audit actor-name snapshot (§5.2, §20) |

### 6b. Domain, money and constraints (Days 5–6)

| Question | Decision | Why |
|---|---|---|
| How are the partial unique indexes created? | **Declared in the schema behind the `partialIndexes` preview feature, after a spike verifies the predicate round-trip** | Since Prisma 7.4, a partial index with no `schema.prisma` declaration is drift, so `migrate dev` emits `DROP INDEX` for it on every run ([#29220](https://github.com/prisma/prisma/issues/29220)). The previously documented "append the SQL to a generated migration" workflow would have silently deleted the double-booking guard on the next unrelated migration. `where` on `@unique`/`@@unique`/`@@index` is documented in Prisma 7 with full PostgreSQL introspection, so the mechanism is known — but the spike still exists, because introspection returns PostgreSQL's *normalised* predicate (`status = 'active'` comes back as `status = 'active'::text`), and a non-round-tripping predicate produces a no-op migration loop on an index that is already correct. `raw()` is required for the `IN (…)` predicate; the object-literal form only expresses equality and `IS NULL`. Fallback if it does not round-trip: an `active_marker` column with `@@unique([patientId, activeMarker])` + `NULLS NOT DISTINCT` (PostgreSQL 18 has it, and no predicate means no drift). `CHECK`s are always raw SQL |
| What are the ids? | **`@default(uuid(7))`, generated by Prisma Client** | Time-ordered, so the high-write tables (`appointments`, `audit_log`, `notifications`) do not fragment their indexes; still unguessable, so nothing is sequential. The plan originally said "PostgreSQL 18's native `uuidv7()`", which exists and was verified on the 18.3 server in use — but Prisma's `dbgenerated()` defaults are a documented source of phantom migrations, because the string in the schema and the value the database returns can disagree and `migrate dev` then wants a migration on every run ([#24240](https://github.com/prisma/prisma/issues/24240), [#9823](https://github.com/prisma/prisma/issues/9823)). Client-side `uuid(7)` removes that class of churn entirely, and the native function buys nothing because every insert goes through Prisma — the only hand-written SQL is DDL, `CHECK`s and guarded `UPDATE`s |
| How are enum values stored? | **Uppercase, exactly as written; only the type name is mapped** | §23's hand-written SQL compares `status IN ('CONFIRMED','ARRIVED')`. Mapping the values to lowercase would make that SQL wrong the day it is written |
| How are instants stored? | **`timestamptz` everywhere; `date`/`time` for clinic-local values** | It makes §3.2's "all timestamps are UTC" a database guarantee rather than a convention a session timezone could reinterpret |
| What is `Schedule`? | **One row per availability window** | A per-doctor record cannot express two windows in a day (§8.1), and §11's "a template change affects only ungenerated dates" needs per-window granularity. The generated slots are the record of what was applied, so no effective-dating is needed |
| Is there an `isClinicCaused` flag on `Appointment`? | **No — derived from `doctorUnavailabilityId IS NOT NULL`** | §12's cascade, §17's refund classification and the audit all key off this fact. Two representations of one fact eventually disagree, and the disagreeing case is a wrongly-refunded or un-refunded patient |
| What is the reminder dedupe key? | **`(appointment, slot)`, enforced by `UNIQUE (appointment_id, slot_id) WHERE type = 'REMINDER'`** | §18 requires the reminder to be once-only, and a key of `(type, appointment_id)` alone breaks after a §14 reschedule: the appointment's slot changes, the index rejects the reminder for the new time, and the patient silently stops being reminded. No other notification type is constrained — repeated events legitimately send more than one email |
| What is the money column type? | **`int` paise, plus `CHECK (amount_paise > 0)`** | `bigint` would break `JSON.stringify` at the API edge — a Phase 6 bug with a Phase 1 cause |
| Where do the enum values come from? | **One table in `plan.md` §24, and nowhere else** | Enum values are the most-transcribed part of a schema: a single mistyped or invented value becomes a migration plus hand-written SQL that no longer matches the ORM, and §23's raw SQL compares these values by string. The table also pins the four traps that are real bugs, not style: `RESCHEDULED` is an event type and not a status, `PENDING` is declared but never written, `SUCCESS` is refund-only, and `AuditLog.action` + every `reason` are text rather than enums |
| What password do the seeded admin/doctors/staff get? | **None — `passwordHash = null`, and no dev-only seed password** | §5.1's rule is that no one ever hands over a credential, so the seeded staff log in through the §6.2 claim link (Day 7's stub prints it) — which also means the claim flow is exercised daily instead of being found broken at hand-off. A "dev password" is a second door into an authenticated account, and second doors are how a seeded `admin/admin123` reaches a real clinic. The two seeded **patients** are the exception: they get a real hash from `SEED_PATIENT_PASSWORD`, because a self-registered account always has a password and a patient with a null hash could never log in |
| How does the seed know the clinic owner's email? | **`CLINIC_OWNER_EMAIL` in the environment**, added to `.env.example` and the config schema on Day 4 | §5.1 says the bootstrap reads the owner's email from environment configuration, but no day ever named the variable, so the seed would otherwise have had to hardcode an address — which becomes the first admin of whoever runs it |
| How does the app handle a local time that does not exist? | **The one conversion helper rejects it, and takes the first occurrence of an ambiguous one** (§3.2) | The clinic's timezone has no DST, so this never fires — but the timezone is configuration, and the failure mode is a slot that quietly moves by an hour, discovered weeks later as "the appointment was at the wrong time" |

---

## 7. Addendum — execution decisions locked at the Day 9 kickoff

None of these is a loophole in `plan.md`, and none changes it — §6.3 already fixes the numbers,
the rotation rule and the re-check. These are choices about **how to build and test** a day that
the specification constrains but does not script, recorded in the same spirit as §6 because each
one is cheap to get wrong and invisible until it bites. `plan.md` is unchanged.

| Question | Decision | Why |
|---|---|---|
| Are the §6.3 thresholds code constants or environment values? | **Env, with the §6.3 numbers as the defaults** | The specification fixes the values but not their home, and the deciding argument is iteration speed: proving a 5-failure lockout by failing five logins is friction paid on every change to the limiter. Unset falling back to the spec'd number means production runs on defaults, so the config is an override rather than a second source of truth. The repo already draws this line — per-deployment values in env (`ACCESS_TOKEN_TTL`, secrets), mechanics in code (bcrypt cost) — and thresholds are policy, but they are also the numbers most likely to be tuned wrongly and most useful to tune deliberately |
| Can an operator turn the lockout off? | **No — there is no value that expresses it** | §6.3 never contemplates a disabled lockout, so the dangerous input is not "0" but *meaninglessness*: any value a reader cannot interpret as a real threshold. A limit that rejects `0` at boot cannot be misread as "lock out on the first failure" or "never lock out", and an absent value falls back to the default instead of disabling anything. A security control whose off switch is a blank line is a control that eventually gets blanked |
| How are those values parsed, given `z.coerce.number()` turns `""` into `0`? | **Counts `.int().positive()`, durations as `/^\d+[smhd]$/` strings** | This is the one place Day 9 could introduce a silent security regression by copying a pattern. `PORT` gets away with coercion only because `.positive()` rejects the `0` an empty string becomes (`config.ts:11`); a limit without that floor can be zeroed by blanking the line, and nothing complains at boot. Durations reuse the `ACCESS_TOKEN_TTL` shape so `15m` stays legible and a duration cannot be typo'd into a count |
| One JSON blob for all eight variables, or eight variables? | **Eight, flat** | They are one policy but four distinct §6.3 clauses — the identity key, the IP key, and the two OTP limits — with separate indexes and separate queries behind them. Flat and individually overridable also means `.env.example` can document each clause next to the number that implements it, which a single blob cannot |
| What does Day 9's `[T]` actually test, given the harness is Day 35? | **The decision logic, as pure unit tests** | Rate limiting is inherently database work, so the temptation is to build the harness early. But the harness is a scheduled Day 35 deliverable that Days 36-38 all extend, and a partial version built now gets rebuilt. Splitting the judgment — given N failures inside the window, is this locked, and until when — out from the counting leaves the part that is easy to get wrong (the escalation ladder, the window boundary, identity key vs IP key) testable with no infrastructure, which is also the style the existing `tests/time.test.ts` already sets. What this cannot reach is the windowed count queries, so those are proven by hand on Day 9 and properly on Day 36. Recording this explicitly keeps Day 36 from looking like a repeat |
| Does Day 9's DoD — *suspending a doctor logs him out everywhere* — hold on Day 9? | **The mechanism is proven through deactivation; the doctor case is Day 12's** | Doctor suspension is Day 12 and password reset is Day 11, so on Day 9 there is no endpoint that suspends anyone. What exists after Day 9 is the mechanism the DoD describes: a per-request status re-check plus `revokeAllSessions` in the same transaction as the status change, demonstrated on `isDeactivated`. Day 12's suspend/archive route calls the same helper. Calling this out now rather than at the end of the day keeps a half-proven DoD from being recorded as a fully met one |
| Does §6.3's “≤5 verification tries per OTP” actually stop an attacker guessing a token? | **Not from the per-OTP key alone — so it also takes the IP key** | This one was found by probing rather than reading, and it is the only place Day 9 shipped a control that did not do what its name said. The cap is keyed on `hash(submittedCode)`, and brute force works by submitting *different* codes: every guess hashes differently, so it arrives under a fresh key with a fresh budget of five. Thirty wrong codes against one issued token returned thirty `400`s and no `429` — indistinguishable from no limit at all, and worse than nothing, because the code read as though the clause were implemented. What the per-OTP key genuinely protects is the *valid* token: five looks total, one of them legitimate, so a leaked token cannot be ground down by resubmission. Bounding the guessing needs the IP key, which §6.3 already assigns to this class of abuse — 20/min against a six-digit space is ~29k/day, which cannot exhaust 10⁶ before the 15-minute token expires. Both keys are now applied, per §6.3's own “two key types” framing, which the earlier code applied only to login |
| Is a per-IP cap on verification safe when several people share one address? | **Yes — the budget is per IP per purpose, not per patient** | The objection worth having is that a locked host could spend every unrelated patient's allowance. It cannot, because the ceiling is 20/min shared across *all* verification traffic from that host, and legitimate verification is a handful of requests — so it sits far above real use while still bounding an attacker. The reason this had to be thought through rather than waved at is that the first draft of the code carried a comment arguing *no* IP term belonged here, on the grounds that one host could exhaust unrelated patients; that argument was about a per-patient ceiling being absent, and it was answered by adding a per-host one instead of by removing the control |
| Can a wrong OTP guess be attributed to the patient it targets? | **No, and that is an endpoint limitation, not a limiter bug** | `/verify-email` carries only the submitted code, and a wrong code matches no `auth_tokens` row — so nothing in the request says which issued token is being attacked, and therefore nothing says which patient. A tighter per-patient verify ceiling is not expressible without changing the contract. The fix is to carry the address in the verification link, which changes the Day 7 link format and the client with it, so it is recorded as a decision here rather than done silently on Day 9. Worth flagging because it is the kind of gap that reads as “fine, it is hashed” until someone tries to brute force a live token |
| §6.3 names `express-rate-limit` — take the package, and is it a real limiter? | **Take it as an outer shed only; `auth_attempts.ipKey` remains the IP authority** | The plan names the library, so the only genuine question was whether to take it, and the repo's minimal-dependency habit argues against — but on a login endpoint the thing worth protecting is bcrypt and the database, and shedding requests before either is exactly what a coarse in-memory layer is good at. It must not become a second authority: two limiters that disagree resolve, in practice, to the more permissive one, and the failure is invisible. The in-memory store is acceptable only *because* the real cap is DB-backed and the app is single-instance (§18 keeps Redis out of the MVP) — which is a dependency worth writing down, since deleting the `auth_attempts` cap would silently promote a per-process guard to sole authority |
