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
| 24 | `User.passwordHash` "nullable for Google users" | §6.1, §24 | Non-nullable — there are no OAuth users |
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
| Unique constraint on `PatientProfile.email` | Already specified (§6.4) |
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
