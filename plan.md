# Doctor Appointment Platform — Master Development Plan

**Project type:** Production-oriented, client-ready clinic appointment management platform  
**Initial scope:** Single internal clinic — an internal booking & management system for one clinic  
**Development target:** 7–10 days for the localhost MVP  
**Current phase:** Planning only — implementation begins after this plan is reviewed

---

## 1. Product Vision

Build a production-oriented doctor appointment and clinic management system for a single internal clinic — real booking, real patients, real payments.

The system must support:

- One internal clinic (not a multi-clinic SaaS)
- Multiple doctors
- Patients
- Admins
- Staff (clinic employees/operators)
- Appointment scheduling
- Dynamic appointment capacity
- Dynamic slot configuration
- Doctor availability/unavailability
- Appointment cancellation and rescheduling
- Online payment and pay-at-clinic
- Email notifications and reminders
- Doctor verification
- Role-based authorization
- Audit logging
- Secure authentication
- API validation
- Testing of critical business flows
- Structured logging/observability

The first implementation is localhost-only. AWS, Docker, CI/CD, HTTPS, and production infrastructure are explicitly deferred until the application is complete and stable locally.

---

# 2. Core Technology Stack

## Frontend

- React
- TypeScript
- Vite
- React Router
- TanStack Query
- Context API
- Tailwind CSS
- shadcn/ui
- Zod
- React Hook Form where appropriate

## Backend

- Node.js
- TypeScript
- Express
- Zod
- Prisma
- Pino
- JWT
- Refresh tokens
- bcrypt
- REST API
- RBAC

## Database

- PostgreSQL
- Prisma ORM
- Prisma migrations
- Transactions
- Database constraints
- Indexes

## External Services

- Resend — transactional email
- Razorpay — online payments

## Testing

- Vitest
- Supertest
- Integration/API testing
- Business-rule testing
- Concurrency/double-booking testing

## Future infrastructure

Deferred until localhost application is complete:

- Docker
- AWS
- RDS
- EC2 / alternative compute
- HTTPS
- Reverse proxy
- CI/CD
- Monitoring infrastructure

## Future AI experimentation

TOON is not the primary API format.

Core application APIs remain JSON/REST.

TOON may later be introduced as a serialization format for structured data sent to an AI/LLM feature, if it provides a practical benefit.

---

# 3. Architectural Principles

## 3.1 Production-oriented, not tutorial-oriented

Do not optimize the application merely for speed of implementation.

Prefer patterns that are:

- Maintainable
- Testable
- Secure
- Extensible
- Understandable
- Appropriate for real-world deployment

Avoid unnecessary complexity when a simpler production-quality solution is sufficient.

## 3.2 Single-clinic scope

This is an internal clinic system, not a multi-clinic SaaS. There is exactly one clinic; a single Clinic record holds its configuration (name, timezone, scheduling defaults).

**Timezone rule:** all timestamps are stored in **UTC**. The clinic-local timezone (the single `Clinic.timezone` config value) is used **only for display** — slot picker, confirmations, reminders — through one shared conversion helper. This avoids DST / server-location clock bugs entirely.

**Default configuration (single source):** all clinic numbers live in the one Clinic config record, seeded with sensible defaults and read through a single settings module — no magic numbers scattered through code. Locked defaults: booking horizon **60 days** (§10), cancel cutoff **1 h** (§8.5), payment hold **10 min** (released at slot start, §8.6), **min lead time 0** (bookable until the slot starts, §8.5), one reminder **2 h before slot start** (§18), max active bookings per patient **3** (§15), default consultation fee + `currency = INR` (§24, §17), access-token TTL **15 min** (§6.3). Optional per-doctor overrides (e.g. horizon) are nullable now so a future per-doctor setting needs no schema migration.

Conceptually:

Clinic
→ Doctors
→ Patients
→ Staff/Admin
→ Schedules
→ Slots
→ Appointments
→ Payments
→ Notifications

Do not build multi-tenant isolation or per-clinic tenancy — it is out of scope. Keep all clinic configuration centralized in the single Clinic record.

## 3.3 Separation of responsibilities

Backend architecture should generally follow:

Route
→ Controller
→ Service
→ Repository/data-access layer
→ Prisma/PostgreSQL

Do not place business logic directly inside route handlers.

## 3.4 Business rules belong on the server

Frontend restrictions are UX features, not security.

Examples:

- Booking horizon
- Appointment ownership
- Capacity
- Doctor permissions
- Admin-only actions
- Payment verification
- Schedule changes

must be enforced server-side.

## 3.5 AI-assisted development, not AI-dependent development

OpenCode/Copilot may generate code, but every important architectural decision must remain understandable to the developer.

If an architectural decision has significant trade-offs, document it rather than silently choosing it.

---

# 4. User Roles

The system has four primary roles:

## PATIENT

Can:

- Register
- Log in
- View public doctors
- Browse doctors by specialization
- View doctor profiles
- View available appointment slots
- Book appointments
- Pay online
- Select pay-at-clinic
- View own appointments
- Cancel own appointments
- Reschedule own appointments
- Update own profile
- Update own email / mobile number (email via verification link, phone via re-authenticated session — no SMS in MVP, §6.1)
- Delete/deactivate own account (§6.1)
- Receive notifications
- Receive appointment reminders

Patients must never access another patient's private information.

## DOCTOR

Can:

- Log in
- View/update permitted profile information
- View own appointments
- View relevant patient/appointment information according to authorization rules
- Set/manage availability where permitted
- Mark unavailable periods
- View schedule
- View the live queue for their slots (attendance is marked by admin/staff, not doctors)
- Receive relevant notifications

Doctors cannot:

- Create arbitrary doctors
- Change their own role
- Access data outside their authorization
- Modify protected administrative settings

## STAFF (front desk / clinic operator)

Runs day-to-day clinic operations. This is the "Clinic employees/operators" role from §1.

Can:

- Log in
- View/update own profile
- Manage appointments (create bookings for walk-in/phone patients)
- Create/invite, update, suspend, and archive doctors — but **not** un-suspend, un-archive, or verify: those three are ADMIN-only (§5.2)
- Check patients in (mark ARRIVED) and mark COMPLETED / NO_SHOW for the day's queue
- Cancel/reschedule appointments per clinic rules
- View doctor schedules, today's slots, and the queue
- Create/update slots and change maxPatients (with the mandatory audited reason, §8.4)
- Mark doctor unavailability
- Record offline (pay-at-clinic) payments
- Look up patient visit history / returning-patient status (§16)
- Create-or-find provisional walk-in/phone patients and manage their bookings entirely at the desk (§16)
- Record the **cash/UPI hand-back** for a refunded pay-at-clinic payment, against the refund record, with no gateway call (§17)
- Review the refund queue — disputes and retried gateway refunds only (§17)
- Receive relevant notifications

Staff cannot:

- Verify or un-archive doctors (creating, updating, suspending, and archiving is allowed for STAFF — §5.2; verification and un-archive are admin-only, §5)
- Change any user's role or manage users
- Configure clinic-wide settings (booking horizon, defaults, etc.)
- View full audit logs (their own actions remain audited)
- Access data outside their duties

## ADMIN

Highest-privilege application role.

Can:

- Manage clinic
- Add doctors
- Invite/provision doctors
- Verify doctors
- Suspend / un-suspend, and archive / un-archive doctors (verification and un-archive are admin-only, §5.2)
- Manage patients
- Manage appointments
- Manage schedules
- Manage slot configuration
- Change slot capacity (with mandatory audited reason, §8.4)
- Approve/reject refund requests
- Manage attendance (check-in ARRIVED, COMPLETED, NO_SHOW)
- Manage doctor availability
- Look up patient visit history / returning-patient status (§16)
- View operational statistics
- Manage relevant users (create/invite staff and doctors, and deactivate staff, per §5.1)
- View audit logs
- Update own profile

Admin operations must be auditable where appropriate.

---

# 5. Doctor Onboarding and Verification

Doctor registration is NOT public.

Recommended flow:

1. Admin **or STAFF** creates/invites the doctor (§4, §5.1).
2. Doctor account is provisioned.
3. Doctor receives invitation/instructions.
4. Doctor completes required profile information.
5. Admin verifies the doctor → `verificationStatus = VERIFIED` (§5). The doctor is immediately bookable and publicly visible.

Required verification information:

- Full name
- Qualification
- Medical license/registration number
- Specialization
- Experience
- Clinic/hospital association

**Doctor state model (locked — replaces the earlier undecided list):**

There are **two independent dimensions**, because verification and suspension are genuinely orthogonal — a doctor can be *unverified and suspended*, and collapsing them into one enum makes that state unrepresentable (and destroys the state needed to restore an un-suspension).

**1. Lifecycle (one enum, `DoctorProfile.verificationStatus`):**

| Value | Meaning |
|---|---|
| `INVITED` | Provisioned (§5.1), has not submitted profile details yet |
| `PENDING_VERIFICATION` | Details submitted, or a verification-impacting field was changed (§5.2); awaiting an ADMIN decision |
| `VERIFIED` | Admin-approved; bookable, publicly visible |
| `REJECTED` | Admin refused the credentials; terminal (a new invite is required) |
| `ARCHIVED` | Permanently off-boarded (soft-delete, §5.2); terminal |

**2. Suspension (orthogonal nullable fields, not an enum value):**

- `suspendedAt` (nullable timestamp) + `suspendReason` (nullable text)
- `null` = not suspended. This replaces the old `ACTIVE` and `SUSPENDED` enum values.

**Derived rules (never stored):**

- **A doctor is bookable iff `verificationStatus = VERIFIED` AND `suspendedAt IS NULL`.** This is the single definition used by slot generation, public listings, and the booking transaction.
- **Un-suspending restores the lifecycle value that was already there** — it clears `suspendedAt`/`suspendReason` and nothing else. A doctor suspended while `VERIFIED` returns to `VERIFIED`; one suspended while `PENDING_VERIFICATION` returns to `PENDING_VERIFICATION`. Suspension therefore **never destroys lifecycle state**, which is what made the old single enum un-restorable.
- A credential edit (§5.2) sets `verificationStatus = PENDING_VERIFICATION` but **does not clear `suspendedAt`** — editing a suspended doctor's credentials must not silently un-suspend them.
- `ARCHIVED` is terminal for every **normal** transition: no booking, schedule or profile action can move a doctor out of it (a profile edit on an archived doctor is rejected outright, §5.2). The single exception is the audited, ADMIN-only **un-archive** path (§5.2), which moves the doctor to `VERIFIED` and clears `suspendedAt`.
- Un-archive always lands on `VERIFIED` regardless of the lifecycle value at archive time, and this is deliberate: an archived doctor is restored only by someone with the authority to verify credentials in the first place, so the un-archiving admin is accepting responsibility for them. It is not a shortcut around §5's verification step — it is that step, performed at restore time — and the audit row records who restored the doctor and why.

A patient cannot become a doctor by changing a client-side role value.

Role assignment is controlled by the backend.

## 5.1 Non-patient account provisioning (bootstrap & invitations)

No self-registration exists for DOCTOR, STAFF, or ADMIN — every non-patient account is provisioned by a trusted actor. Three cases:

**Bootstrap — the first ADMIN:** created during local setup by a setup/seed command that reads the clinic owner's email from environment configuration. One account, one time, created outside the website. The owner claims it through the existing forgot-password flow (§6.2) — do not generate or hand over a temporary password; the claim is audited like any other password reset.

**STAFF accounts:** created by ADMIN on the website (Admin dashboard → add staff: name + email). The staff member receives an invitation email and claims the account via the same §6.2 email link/OTP flow. STAFF can never create other staff members or change roles.

**Staff offboarding (ADMIN only) — deactivation, never deletion:** a staff member who leaves is **deactivated**, in one atomic transaction that:

1. **Refuses login immediately** and **revokes every active session** — every refresh token for that user is revoked in the same transaction and the per-request status re-check (§6.3) rejects any already-issued access token, exactly as for a doctor suspension (§5.2).
2. **Leaves history completely intact.** Audit rows, `AppointmentHistory`, `DoctorHistory`, slot edits and payment records are never rewritten or removed. Attribution survives because every audit row already stores the actor's name **snapshot** taken at action time (§5.2, §20) — deactivating someone cannot retroactively change who did what.
3. Is **audited with a mandatory reason** (actor, target, before/after, ip, request id, timestamp).

Deactivation is immediate and **terminal in MVP** — there is no "reactivate" and no scheduled future-dated variant for staff; the richer doctor lifecycle in §5.2 (suspend / un-suspend / archive / un-archive) is a separate flow and does not apply. If the same person is ever needed again, a new account is created. A deactivated staff member cannot log in and cannot be assigned any new action.

**DOCTOR accounts:** created/invited by ADMIN **or** STAFF (§4, §29). The doctor receives an invitation email, claims the account via §6.2, completes profile information, and is verified by ADMIN (§5 above). After verification, STAFF may update, suspend, and archive doctors per §5.2 — STAFF cannot verify or un-archive doctors.

All three cases reuse the one "provisioned account → claim via email" mechanism (§6.2), so there is no separate onboarding wizard to build — the invitation email simply points at the login page.

## 5.2 Staff doctor management (add / update / suspend / archive) — locked attribution

STAFF can create, update, suspend, and archive doctors. Verification and un-archiving remain ADMIN-only. Every action is recorded once, immutably, with the acting staff member's identity locked in at action time (§20) — "who did what, when, and why" is always answerable and can never be rewritten. Additionally, **every STAFF doctor action emails an admin summary** (§18) — with the acting staff name, the action, the target doctor, and the reason — so admin is never blind to staff changes, even before checking the audit log.

**Add (create/invite):** STAFF creates/invites a doctor (§5.1). The invitation-email + claim flow applies; verification stays ADMIN-only.

**Update (profile edit):** STAFF may edit descriptive and contact profile fields (full name, contact details). The **verification-impacting fields — qualification, medical license/registration number, specialization, experience, clinic/hospital association — are also editable, but they trigger re-verification** (rule below). STAFF cannot change verification status, roles, or permissions. Every change writes a `before`/`after` row to `DoctorHistory` and the `AuditLog`. An `ARCHIVED` doctor is excluded entirely: a profile edit of any kind on an archived record is rejected, because it would be a profile action moving the doctor out of `ARCHIVED` (§5) — restoring an archived doctor is the audited un-archive path only.

**Credential edits force re-verification (locked):** a change to any verification-impacting field — made by **STAFF, by ADMIN, or by the doctor themselves** — sends the doctor back to `PENDING_VERIFICATION` until an **ADMIN re-verifies** (§5). A doctor cannot re-verify themselves and cannot keep a `VERIFIED` badge on credentials nobody has re-checked, which is the loophole this closes. While re-verification is pending, the doctor **keeps every existing appointment untouched** (§11 — no booking is cancelled or moved) but is **hidden from new patient bookings** until re-verified, so no new patient is booked against unverified credentials. The field change, the status flip, and the later re-verification are all audited and written to `DoctorHistory`.

**Suspend:** STAFF and ADMIN can suspend a doctor. Suspension sets `suspendedAt` + `suspendReason` (§5) and is **one atomic transaction** that:
1. Disables the doctor's login — **revoking every active session in the same transaction**: all of the doctor's refresh tokens are deleted (§6.3), and the per-request status re-check (§6.3) rejects any already-issued access token immediately, so suspension takes effect at once rather than at token expiry. It also hides the doctor from patients and stops slot offer/materialization — **no new bookings can form**.
2. **Auto-triggers the §12 affected-appointment cascade** for every future confirmed booking: all affected patients are emailed automatically ("clinic-caused — reschedule or cancel; cancellation yields a full refund"), the cancellation cutoff is waived, unresponsive bookings **auto-cancel after the slot ends** and are refunded automatically (§17), and `NO_SHOW` is never applied. No per-patient manual work is required — the acting staff member cannot forget to notify patients.
3. Writes the locked audit record with a mandatory reason (`actor staffId` + **`staffName` snapshot**, action, target, before/after, reason, ip, request id, timestamp).

**Un-suspend (ADMIN only):** clears `suspendedAt` and `suspendReason` and **nothing else** — the doctor returns to whatever `verificationStatus` they already held, so a doctor suspended while `VERIFIED` becomes bookable again immediately, and one suspended while `PENDING_VERIFICATION` returns to awaiting verification rather than silently becoming bookable (§5). Slot materialization resumes; slots closed by the suspension are re-enabled **only** where no other overlapping unavailability exists (§8.4), audited. Suspension changes are audited with a mandatory reason and mirrored to `DoctorHistory`.

**Race guard (both paths):** the booking transaction re-reads the doctor's `verificationStatus` and `suspendedAt` **inside its own transaction** and rejects unless the doctor is bookable (§5). This covers immediate suspension as well as archive — without it, a booking that read the slot as enabled microseconds before a suspend commits could still insert a `CONFIRMED` appointment *after* the §12 cascade had already run, stranding one patient with no notification and no refund path.

**Archive (ARCHIVED — soft-delete):** permanent off-boarding, STAFF or ADMIN. Same atomic transaction as suspension but terminal:
1. Runs the same §12 cascade for any future confirmed bookings (auto-notify + full-refund + auto-cancel at slot end).
2. Sets `verificationStatus = ARCHIVED` and clears `suspendedAt`; **no hard `DELETE` ever** — the doctor row and all appointment/payment history remain (referential integrity; booking-time snapshots of `doctorName` / `feeAmount` protect what patients saw).
3. Un-archive is ADMIN-only; it moves the doctor to `VERIFIED` and clears `suspendedAt`. Archived doctors cannot log in, every active session is revoked (§6.3), and they are hidden from patients.
4. Wholly audited with locked attribution; `DoctorHistory` records the terminal state.

**Scheduled/future-dated offboarding is not in MVP.** A small clinic suspends or archives a doctor on the day it happens; `scheduledAction` / `effectiveAt` fields and the boundary job are deferred (see §42). If it is added later it must not weaken the race guard above.

**Who-did-it guarantees (the lock):** the acting `staffId` and a **snapshot of `staffName`** captured at action time are embedded in the append-only audit row (§20), so a later rename or deactivation of that staff member can never rewrite attribution. No edit/delete API exists, the repository layer exposes insert-and-read only for audit tables, and a test asserts that attempting an update or delete through the application's data layer fails. Combined with the mandatory reason, no future conflict about "who did this" can arise. *(Enforcing immutability with database `REVOKE` grants is deliberately not required in MVP — it is invisible to every user, adds migration and grant-management burden, and a single wrong `REVOKE` breaks the running app. It remains available as a deployment hardening step, deferred to §42.)*

---

# 6. Authentication

Use:

- JWT access token
- Refresh token
- HTTP-only secure cookie strategy
- bcrypt password hashing

**Every role authenticates with traditional credentials** (registered email + password). Google OAuth is **not** in MVP: it adds a second auth path, a client-redirect flow, and an account-linking surface for no clinic benefit — patients do not choose a clinic based on how they log in. It remains a clean future addition (§42) because the account model already keys on a unique email.

Do not store long-lived authentication secrets in localStorage.

Authentication and authorization are separate concepts.

Authentication answers:

"Who are you?"

Authorization answers:

"Are you allowed to perform this action?"

Both must be implemented.

## 6.1 Patient account management

Patients can manage their identity from the patient dashboard.

**Update email / mobile number:**

The two fields have **different** verification rules in MVP, because there is **no SMS channel** (§6.3) — a phone OTP cannot be built, so it must not be specified:

- **Email** — ownership verification via a **verification link sent to the new email** (the same single-use link/OTP service as §6.2/§6.3). The change is held as `pendingEmail` and becomes active only when the link is opened.
- **Phone** — authorized by the **authenticated, email-verified session plus a re-authentication step** (current password or email OTP, §6.2). The new number is normalized to **E.164** and stored with `phoneVerified = false` (`phone_unverified`); it can be verified later only if an SMS/WhatsApp channel is introduced (§42). **Do not add a phone-OTP flow in MVP** — there is no channel to deliver it, so "verify by OTP" is a dead end, not a feature.
- Both values must pass the **uniqueness check** before the change is accepted (phone primary, email secondary — §16, §24); a duplicate is rejected with a clear message.
- Until an email change is verified, the old value stays active (no half-changed identity). A phone change applies immediately on acceptance, because what is being proven is the session, not the new number.
- Every change is audited (actor, field, old value, new value, timestamp).

**Delete account:**

- Patients can delete/deactivate their own account from the dashboard.
- Because the clinic must retain appointment and payment records, deletion is a **deactivation with PII anonymization**, not a hard delete: login is disabled and personal details are anonymized, while historical appointment/payment records remain for clinic records.
- Guard rails: the patient must have **no upcoming confirmed appointments** and **no pending payments/refunds** — these must be cancelled/resolved first.
- **Active holds at deletion (hold-safe rule):** the patient must also have **no active seat hold** (§8.6). The delete handler runs as **one atomic DB transaction** that (1) **releases every active hold** — `held_count - 1` on each affected slot via the same conditional guard as §15/§17, writing `releasedAt`/`releaseReason = DELETED_WITH_ACCOUNT` on each `SeatHold` (§8.6; holds are released, never deleted, so the freed seat stays provable); (2) **voids each hold's pending payment order** (`VOIDED` — no money has moved yet for a hold, so nothing to refund and no gateway call); (3) **only then** applies the pending-money guards above — any guard failure rolls the entire delete back, so there is never a partial release or an orphaned hold; (4) deactivates + anonymizes and revokes all sessions (§6.3). Because an unfinished online booking has **no appointment row** (§13), there is no appointment to clean up here at all. Every released hold, voided order, and the deletion itself are audited (actor, target, before/after, ip, request id, timestamp).
- **Late-payment race:** if a Razorpay payment lands *after* the delete has committed, the §17 verification handler finds no valid hold → rejects the booking and **auto-refunds** the received amount (money that moved always goes back). Pay-at-clinic bookings have no hold (immediate CONFIRMED), so they are covered by the "no upcoming confirmed appointments" guard instead.
- Requires re-authentication (password/OTP) to confirm.
- The deletion is audited.

## 6.2 Password reset (all roles)

Available to every role (PATIENT, DOCTOR, STAFF, ADMIN). The account must exist in the database with a registered email on file.

The user chooses **one of two methods** to verify ownership before resetting:

1. **Reset link by email** — a time-limited, single-use tokenized link sent to the registered email; opening the link takes the user directly to the reset-password portal.
2. **OTP by email** — a time-limited OTP sent to the registered email; entering the correct OTP on the forgot-password page opens the same reset-password portal.

Rules (backend-enforced):

- Both the link and the OTP are sent only to the **registered email on file** (no SMS/phone reset in MVP).
- OTP/token expiry is short (default: 15 minutes, configurable) and **single-use** — invalidated after a successful reset or on resend.
- Rate limiting on reset requests (prevents email-bombing / enumeration); responses are generic ("if the account exists, an email was sent") so account existence is never leaked.
- The reset-password portal (reached via link **or** OTP) accepts the new password, hashed with bcrypt.
- A successful password reset **invalidates all existing refresh tokens/sessions** for that user (forces re-login everywhere).
- Password reset is **audited** (actor, method used, timestamp).

## 6.3 Authentication hardening (all roles)

**Rate limiting + lockout (backend-enforced):**

- Login / OTP-send / OTP-verify failures are tracked in a DB-backed `auth_attempts` table (PostgreSQL; no Redis in MVP).
- Two key types:
  - **Identity key (email)** — primary defense: e.g. 5 consecutive failures → 15-minute lockout.
  - **IP key** — secondary cap (e.g. 20 attempts/min/IP) guarding against account sweeping and OTP email-bombing.
- OTP limits are stricter: ≤ 3 OTP sends per 15 minutes per address; ≤ 5 verification tries per OTP.
- Escalating lockout: repeated lockouts grow 15 → 30 → 60 minutes (cap).
- Blocked requests return a generic `429` with `Retry-After`; responses never reveal whether an address exists.
- A coarse `express-rate-limit` layer wraps auth routes as an outer guard (§22).

**Refresh tokens:**

- Refresh tokens are opaque random strings stored **hashed (SHA-256)** in a `refresh_tokens` table with `id, userId, tokenHash (unique), expiresAt, revokedAt, ip, userAgent, createdAt`.
- Every refresh issues a **new token** and revokes the previous one (rotation) — a stolen token is usable once.
- Presenting an already-revoked token simply **fails**; the user re-authenticates. *(Token-family theft detection — the `familyId` column and the "revoke the whole family" response — is **not** in MVP: it is invisible to legitimate users, adds a second revocation concept, and buys nothing against the threat that matters here, which is a live session belonging to a suspended doctor. A future authenticated session listing (§42) supersedes it.)*
- **"Revoke every session" means one statement:** set `revokedAt` on every `refresh_tokens` row for that user. It is used on password reset (§6.2), account deactivation, staff deactivation (§5.1) and doctor suspension/archive (§5.2) — so suspending a doctor logs him out everywhere, immediately, in the same transaction as the status change.
- **Access tokens are short-lived** (default **15 minutes**) — they are never a durable credential.
- **Per-request status re-check (backstop):** besides verifying the signature, the authenticated-request guard re-checks the account's current state on every request for DOCTOR / STAFF / ADMIN (bookable / not suspended / not archived / not deactivated, §5). A short TTL alone is **not** sufficient: a suspension, archive or staff deactivation must take effect **immediately**, not at the next token expiry (§5.1, §5.2).

**Registration verification (email-only):**

- New patient accounts start as `EMAIL_UNVERIFIED`; a one-time email link or OTP (via Resend) verifies the account, and **booking is blocked until verified** — prevents fake/squatting accounts.
- **Phone is collected at registration but stays `phone_unverified` in MVP — no SMS channel.** Phone verification is added later only if an SMS/WhatsApp channel is introduced (§42 future).
- Reuses the same generic OTP/link service as §6.2 (issue, verify, single-use, expiry, rate-limited).
- Doctors/staff/admin need no registration verification — they are provisioned per §5.1 (bootstrap for the first admin; ADMIN or STAFF invites the rest).

## 6.4 Email uniqueness (all entry points — locked)

- `User.email` carries a **database UNIQUE constraint**, and **every** entry point resolves against it: patient registration, invitation claim (§5.1), and email change (§6.1).
- An invitation sent to an address that is already registered **cannot be claimed** — the claim flow refuses and reports that the address is in use. This is the rule that stops an existing account from being taken over through someone else's invite, and it is the reason email must be unique across **all** account types (patient, doctor, staff, admin), not per role.
- There is **no auto-linking and no silent merging** in MVP. Linking two accounts requires proof of ownership of both plus an explicit merge flow, neither of which exists; a collision is reported to the user, never resolved automatically.
- *Google OAuth is not in MVP (§6), so it is not an entry point here. If it is added later it resolves against this same constraint and inherits the reject-never-link rule unchanged.*

---

# 7. Authorization / RBAC

Use role-based authorization:

- PATIENT
- DOCTOR
- STAFF
- ADMIN

Additionally, ownership and relationship checks are required.

Example:

A logged-in patient requesting `/appointments/:id` is not automatically allowed to see that appointment.

The backend must verify that the appointment belongs to the authenticated patient.

Similarly:

A doctor may only access appointments associated with their own doctor relationship.

A staff member may only access operational data required for their duties.

Admin permissions are broader but must still respect patient privacy.

---

# 8. Appointment Scheduling Model (Slot/Window Model)

## 8.1 Slot-based scheduling

Appointments are booked against available slots. A slot is NOT a sub-interval of working hours. It is the entire period during which the doctor sees patients.

Example schedule for a doctor (Monday):

- 07:00–09:00 → one slot
- 18:00–20:00 → another slot

There are no sub-slots, no per-patient appointment times, and no slot duration.

Each slot belongs to a doctor and a calendar date and stores:

- `slotDate` — the clinic-local calendar date this slot is for
- `startTime` / `endTime` — clinic-local wall-clock window (the slot is the whole window; there are no sub-slots, §9)
- `startAt` / `endAt` — the same window as UTC instants, written once at creation through the single conversion helper (§3.2). **Every time comparison in the system uses these two fields, never server-local time and never the wall-clock fields.**
- `maxPatients` (head count the doctor will see in the slot)
- `bookedCount` — a **stored counter**, not a derived value. It counts every seat currently consumed by an appointment in a seat-holding status (`CONFIRMED`, `ARRIVED`, `COMPLETED`, `NO_SHOW` — the last two do **not** release the seat, §13.1). It is moved only by the atomic guarded update in §15, never recomputed from statuses, and it never includes holds.
- `heldCount` — a stored counter of live `SeatHold` rows (`releasedAt IS NULL`, §8.6), moved by the same guard.

Unique on `(doctorId, slotDate, startTime)` so slot generation and bulk week-create are idempotent (§11).

A booking = date + slot + queue position:

- The first patient booking a slot gets queue position 1, the second position 2, and so on.
- Ordering within the slot is first-come, first-served by booking time. Position is a **display rank computed from booking time**, not a stored mutable counter — so when a middle booking is cancelled the remaining patients simply close up, and no renumbering logic or uniqueness constraint on a position column is needed. It is never `SELECT count + 1` at booking time (that races); the appointment is created in the same transaction that consumes the seat (§15, §17), and its rank falls out of the booking time already recorded.

Example:

Slot: Mon 07:00–09:00 (Dr A)
- maxPatients: 15
- booked: 14, held: 1

The slot is unavailable for patient booking (14 + 1 = 15).

## 8.2 maxPatients (capacity) is dynamic

Clinic administration can configure:

- Which working days a doctor is available
- Slot windows (start/end) per working day
- maxPatients per slot
- Slot availability
- Schedule rules
- Booking horizon

maxPatients can be raised or lowered at any time. Every change is recorded with an audited reason (actor, before, after, reason, timestamp).

## 8.3 Capacity change

The slot model has no separate "emergency override" concept. A slot is full when `bookedCount + heldCount = maxPatients` (§15) — live holds count toward fullness, so a slot can be unavailable while `bookedCount` is still below `maxPatients`.

If an authorized admin/staff member needs to accept an extra patient, they raise maxPatients (with the mandatory reason from §8.4) and the booking proceeds normally.

The system must record:

- Actor/staff
- Slot
- Previous maxPatients
- New maxPatients
- Reason
- Timestamp

This becomes an audit event.

Normal patients cannot change capacity.

## 8.4 Mandatory reason on every capacity/slot change (backend-enforced)

- Changing `maxPatients` of a slot **requires a text reason**. If the reason is missing, the backend rejects the request (e.g. `422`). The check is enforced server-side; a frontend restriction is a UX nicety, not enforcement.
- The **same rule applies to every other slot edit** — disable a slot, change slot times, mark doctor unavailability — so staff cannot bypass the reason field through a different screen.
- **Lowering `maxPatients` below `bookedCount + heldCount` is blocked.** Both seats already consumed and seats reserved by live holds count, because a hold is a promise of a seat. The backend fails loudly with a message such as "X patients booked and Y awaiting payment for this slot" (§15).
- **Editing a slot's date or times is blocked while the slot still holds a seat — a `CONFIRMED` or `ARRIVED` appointment, or a `COMPLETED`/`NO_SHOW` on a not-yet-ended slot, because those keep the seat (§8.1) — or while live holds exist** — a hold's expiry is `min(now + holdDuration, slot.startAt)` (§8.6), so moving a slot's start silently moves an already-reserved seat's deadline. An appointment reads its date and time from the slot it belongs to, so moving a booked slot would silently move every confirmed patient's appointment — and re-anchor their reminders. Staff must create a new slot instead. **Capacity-only edits (`maxPatients`) stay allowed and must never touch the times.** This is the mechanism behind §11's promise that existing appointments preserve their scheduled date/time.
- **Disabling a slot, or removing it, is blocked while it still holds a seat (any `CONFIRMED`, `ARRIVED`, or not-yet-ended `COMPLETED`/`NO_SHOW` appointment, §8.1) or while live holds exist** — the same rule, for the same reason: there is no §12-style notification, cutoff-waiver or refund path for "a staff member disabled this slot", and a paid patient would be left with a booking on a slot that no longer exists. Staff move the patients with §14 reschedule (or cancel them with a reason) and then disable the slot. A disabled slot is re-enabled by explicitly re-enabling it, audited with a reason; removing an unavailability re-enables exactly the slots it closed and no others (§12).
- Every change writes an **append-only audit row**: `actorId`, `actorRole`, `slotId`, `before`, `after`, `reason`, `ip`, `timestamp`.
- Normal patients can never perform these actions.

## 8.5 Booking and cancellation cutoffs

- **Minimum booking lead time: 0 (none).** A slot is bookable only **while it has not started**. Once the slot's start time passes, the slot is "running" and cannot be booked — the frontend hides started slots and the backend rejects any booking attempt (e.g. a 10:00–12:00 slot is bookable until exactly 10:00). Patients judge the timing naturally from the slot window.
- **Cancellation cutoff:** a patient may cancel their booking only **before 1 hour before the slot starts**. Example: for a slot 21:00–22:00, cancellation is allowed until 20:00; from 20:00 onwards cancellation is rejected.
- **Cutoff waiver:** the cutoff is **waived for appointments affected by doctor unavailability** (§12) — clinic-caused, so patients may cancel/reschedule until the slot starts.
- **Rescheduling follows the same rule** for patient-initiated changes, so a patient cannot bypass the cutoff by cancelling and rebooking nearby.
- Both rules are **enforced on the backend** (reject with a clear error/code). The frontend only hides the option — enforcement is not client-side.
- Admin/staff-initiated cancellations are not bound by the patient cutoff, but every such action is audited with the actor and a reason.

## 8.6 Seat hold (reservation) for online payment

Online bookings reserve capacity with a temporary hold before payment (see also §17).

**The hold is a real database record, and it is the only trace of an unfinished booking.** A hold is a `SeatHold` row (§24) — never an `Appointment` row. No appointment exists between "patient starts paying" and "payment is verified"; the appointment is **created** at verification. This is deliberate, and §13, §15, §17 and §24 all depend on it.

- Starting an online booking atomically reserves the seat (`held`) and creates the `SeatHold` + payment order. **No `Appointment` row is created at this point** — an attempt that is abandoned or expires leaves nothing behind to correct.
- Hold duration: **10 minutes** (configurable).
- **A hold never extends into a running slot:** the effective expiry is stored on the row as `expiresAt = min(now + 10 min, slot.startAt)`, so the slot-start release needs no separate rule. An abandoned online booking started shortly before the slot simply becomes an unsold seat (§8.5).
- Capacity rule: `booked + held < maxPatients`.
- **Release is a state transition, never a deletion:** expiry, abandonment, payment failure and successful conversion all write `releasedAt` + `releaseReason` (`EXPIRED` / `ABANDONED` / `PAYMENT_FAILED` / `CONVERTED` / `DELETED_WITH_ACCOUNT` — §6.1). A seat is free exactly when `releasedAt IS NULL AND expiresAt > now()`, which is a property of the row itself.
- **Correctness of a hold is enforced in code, not by a cleanup job.** Every path that consumes a hold re-checks `releasedAt IS NULL AND expiresAt > now()` inside its own transaction (§15, §17), and the booking path re-counts the live rows (`WHERE releasedAt IS NULL AND expiresAt > now()`) inside the same `SELECT … FOR UPDATE` transaction instead of trusting the stored counter or the hold's own copy. So an expired-but-unreleased hold can never consume a seat, even if no process ever runs.
- **`releasedAt IS NULL` is deliberately NOT a time-aware predicate, so the stored counters are repaired, not trusted.** `expiresAt > now()` cannot appear in a SQL partial index, so `UNIQUE (patientId) WHERE releasedAt IS NULL` and the "active booking" lookups read a state that only *becomes* false when something writes it. Two consequences, both accepted in MVP:
  - A **hold-expiry sweep** releases overdue holds on an interval **and once at startup before traffic is served** (part of the in-process jobs, §18). It is the only job whose absence has user-visible effect, and that effect is bounded and self-healing: until it runs, an expired hold keeps counting toward `heldCount` and keeps occupying the one-hold-per-patient slot.
  - Therefore **`heldCount` is authoritative only immediately after the sweep**, and no correctness decision may be made from a cached or denormalized value. Read the live rows (`SELECT count(*) ... WHERE releasedAt IS NULL AND expiresAt > now()`) whenever a decision must not be stale; `heldCount` is maintained for fast availability lists and is a lower bound on the true free-seat count, never an upper one.
  - This is precisely why an appointment is never modelled as a hold-like `PENDING` row: a `CONFIRMED` appointment's seat is protected by the appointment row itself, so the only "self-healing needed" state in the system is an unsold seat, which is harmless.
- Late payment after expiry → no valid hold → the booking is rejected and the payment is auto-refunded (§17).
- Max **1 active hold per patient** (prevents seat squatting), enforced by `UNIQUE (patientId) WHERE releasedAt IS NULL` on `SeatHold` **plus** the in-transaction time re-check above — the index stops a patient taking two holds in the same instant, the time check is what makes the rule correct after expiry.

---

# 9. Appointment Timing

There is no per-patient appointment time and no slot duration.

A slot's length is simply its start–end window (e.g. 07:00–09:00). Within that window the doctor sees up to maxPatients patients, ordered by queue position.

The system must not assume an average consultation duration. If a future clinic ever needs timed appointments, a separate timed model can be introduced later without reworking the core slot model.

---

# 10. Booking Horizon

Patients must not be able to book arbitrarily far into the future.

Introduce a configurable booking horizon.

Example:

Default:

60 days

Possible clinic configurations:

- 7 days
- 30 days
- 60 days
- 90 days
- 180 days

The frontend should only present bookable dates where practical.

The backend must independently enforce the booking horizon.

A malicious client request for a date beyond the horizon must be rejected.

---

# 11. Schedule Changes

Clinic admins/employees can modify future scheduling configuration.

Examples:

- Change working days
- Change slot windows (start/end)
- Change maxPatients for a slot
- Add slot
- Disable slot
- Remove future slot/schedule
- **Bulk week setup:** create/update a whole week of slots for a doctor in a single request (`POST /slots/bulk`, one transaction, all-or-nothing) — each slot still carries the mandatory audited reason (§8.4). Manual per-slot entry is not the practical path.

Important rule:

**Existing confirmed/booked appointments must never silently move.** The mechanism is in §8.4: a slot's date/times cannot be edited, and it cannot be disabled or removed, while it holds active bookings or live holds — so there is nothing for a schedule change to move underneath a patient. Staff reschedule the patients (§14) and then change or disable the slot.

New configuration applies to future bookings. A change to a doctor's weekly template (§24) affects **only dates that have not been generated yet**; already-generated slots are corrected through the normal audited slot-edit path above. Slot generation itself is an idempotent job that materializes concrete dated slots from the template across the booking horizon (§10), so the horizon stays stocked without anyone entering weeks by hand.

**Bookings must also be rejected into a window the doctor is unavailable for.** The booking transaction re-checks for an overlapping `DoctorUnavailability` inside its own transaction, and the slot-listing query filters out overlapping windows. Without this, the notification cascade below would email a patient about a booking that should never have been accepted in the first place.

---

# 12. Doctor Unavailability

Staff, doctors and admins can mark a doctor unavailable for a period.

Example:

Doctor unavailable:

2026-09-20
10:00–14:00

The system must identify affected appointments (CONFIRMED bookings whose slot overlaps the unavailability).

**No auto-reschedule — ever.** The clinic never silently moves a patient's booking. Instead:

- Each affected patient is notified by email: "Dr X is unavailable for your [date/slot]; please reschedule to another slot or cancel — cancelling gives a full refund."
- The patient acts (or staff helps at the desk): reschedule themselves (§14) into a valid slot, or cancel.
- **Cancel/reschedule cutoff (§8.5) is waived for affected appointments** (clinic-caused), until the slot starts.
- Affected appointments carry a reference to the DoctorUnavailability record (not a new status), so refund classification and audit always know the change was clinic-caused.

Patient cancellation → classified clinic-caused → **full refund, executed automatically** per §17. No admin approval is needed for a clinic-caused cancellation.

**No response before the slot starts:** the appointment is **auto-cancelled after the slot ends** (background job, clinic-caused) and paid patients are **refunded automatically** (§17). Notification and audit are recorded.

**Affected means `CONFIRMED` only — attendance is never overwritten.** The auto-cancel job re-reads each candidate row when it runs and cancels only those **still `CONFIRMED`** at that moment. A patient who was already marked `COMPLETED` or `NO_SHOW` is outside the affected set entirely (§12, §13.1) and can never be auto-cancelled. This holds for a slot that had already started when the disruption happened: patients already seen or already marked absent keep their recorded outcome, and staff cancel the remaining `CONFIRMED` patients clinic-caused (cutoff waived, full refund, notified) — a `NO_SHOW` is never applied to a clinic-caused window.

`NO_SHOW` is never applied to an appointment affected by doctor unavailability (the clinic caused the disruption).

The rescheduling workflow preserves appointment history (§14).

Doctor suspension/archive (§5.2) reuses this same cascade: identical automatic emails, cutoff waiver, full-refund path, and auto-cancel at slot end — applied automatically to all the doctor's future confirmed bookings the moment the suspension/archive commits. No extra code path or manual steps.

---

# 13. Appointment Status

Statuses:

- CONFIRMED
- ARRIVED
- COMPLETED
- CANCELLED
- REJECTED
- NO_SHOW
- (PENDING is a valid enum member for forward compatibility but is never written — see below)

**`PENDING` is not written (locked):** an appointment is **never** created in a pending state. Pay-at-clinic bookings are born `CONFIRMED` (§17), and an online booking's appointment row is **created** as `CONFIRMED` at payment verification (§8.6, §17) — before that moment the attempt lives only as a `SeatHold` + `PENDING` payment order. The reason is correctness, not tidiness: `PENDING` would be an appointment that *looks* active to the same-slot index and the per-patient cap (§15) while quietly not being one the moment the hold expires, so an abandoned attempt would block that patient from that slot and burn one of their 3 booking slots **permanently**. With no such row, an expired hold is released by deleting nothing and correcting nothing (§8.6). The status may be kept in the enum for forward compatibility, but nothing may write it.

**Not a status — a history event:** `RESCHEDULED` is **not** an appointment status. A reschedule moves the existing appointment to the new slot (§14), so the row is still `CONFIRMED` afterwards; `RESCHEDULED` exists only as an `AppointmentHistory` event type recording old → new slot. Adding it to the status enum would create a row with no slot, which nothing else in this plan can handle.

**`REJECTED` — the one trigger (locked):** an ADMIN or STAFF member refuses a booking at the desk for a policy or eligibility reason (e.g. a request the clinic cannot honour, a suspected duplicate/fraudulent booking). It requires a **mandatory reason**, is written to `AppointmentHistory` and the audit log with the actor, and notifies the patient (§18). It is **not** used for a failed payment, an expired hold or a full slot — those cases never create an appointment row at all (§8.6), so there is nothing to reject. If no staff member ever rejects a booking in practice, the value simply goes unused; it is kept because §18 and §33 both require a rejection notification and test.

**Transition matrix (locked — enforced server-side):**

| From | To | Who | Allowed when |
|---|---|---|---|
| — (create) | `CONFIRMED` | PATIENT (self-booking), STAFF/ADMIN (desk) | Slot has a free seat, passes all §15 guards, is bookable (§5 doctor state, §8.5 lead time, §10 horizon, §12 no unavailability overlap) |
| `CONFIRMED` | `ARRIVED` | ADMIN, STAFF | Patient physically present; from slot start (§13.1) |
| `CONFIRMED` | `CANCELLED` | PATIENT (own, before the §8.5 cutoff), ADMIN, STAFF, **SYSTEM (job)** | Cutoff waived for clinic-caused changes (§8.5, §12). The `SYSTEM` actor is the §12 auto-cancel job; it is recorded with `actor = system` and the triggering `DoctorUnavailability` / doctor-status change as the reason |
| `CONFIRMED` | `NO_SHOW` | ADMIN, STAFF | Only **after** `endAt`; patient never arrived |
| `ARRIVED` | `CANCELLED` | ADMIN, STAFF only | Clinic error (e.g. booked in error). Requires a reason; audited |
| `ARRIVED` | `COMPLETED` | ADMIN, STAFF | Consultation happened. **Never directly from `CONFIRMED`** — this is the only thing that makes a patient a "returning patient" (§16), so it must not be settable by a single desk click |
| `CONFIRMED` | `REJECTED` | ADMIN, STAFF | Policy/eligibility refusal with a mandatory reason (above) |

**Rescheduling is deliberately not a row in this table**, because it is not a status change: it moves the **same row** to a different slot (§14) — `CONFIRMED` to `CONFIRMED`, permitted for PATIENT (own booking, before the cutoff), ADMIN or STAFF, obeying the same cutoff and capacity guards as a fresh booking (§14, §15), with a `RESCHEDULED` event written to `AppointmentHistory`. Listing it in a "To" column would contradict the rule above that `RESCHEDULED` is not a status.

**Terminal states:** `COMPLETED`, `NO_SHOW`, `CANCELLED` and `REJECTED` accept **no further transitions**. There is no "undo cancel" in MVP — a cancellation recorded in error is corrected by a new booking plus an audit note, not by reviving the row, because a revived row would have to invent a queue position and re-validate a slot that has since filled. Any correction that must still change a terminal row is a separate, explicitly audited admin action, not a normal transition.

Do not add statuses merely for completeness; each status must have a clear business meaning.

**Appointment history:** every state change is written to an append-only per-appointment timeline (`AppointmentHistory`) — booked → paid → confirmed → rescheduled (old→new) → cancelled → rejected → arrived → completed → no-show, each with actor + timestamp + metadata. See §20 (distinct from the admin AuditLog) and §33.

Appointment status and payment status must be separate.

## 13.1 Attendance / check-in workflow

Because a slot is a batch (a window with a queue), the clinic must track who actually arrived.

State flow:

```
CONFIRMED ──arrives──▶ ARRIVED ──seen──▶ COMPLETED
    │
    └──window ends, never arrived──▶ NO_SHOW
```

Rules:

- **Who can mark:** ADMIN and STAFF only. Doctors can view the live queue but cannot change attendance status.
- **These rules are enforced on the backend**, not just hidden in the UI: `COMPLETED` is accepted **only** from `ARRIVED` (never straight from `CONFIRMED`); `NO_SHOW` is accepted **only** from `CONFIRMED` and **only** once the slot's `endAt` has passed; `ARRIVED` is accepted from `CONFIRMED` from the slot's start onward; and a terminal state accepts no further attendance change (§13). A rejected transition returns a clear error naming the current status and what is allowed from it.
- **ARRIVED:** marked when the patient physically reaches the clinic; drives the doctor's live queue ("who is waiting").
- **COMPLETED:** marked after the consultation.
- **NO_SHOW:** marked manually after the slot ends for any patient still CONFIRMED (never arrived). MVP is manual; a background job may auto-flag after a grace period later.
- **NO_SHOW does not free the seat** at booking time — capacity was already consumed. It is recorded for stats (no-show rate per doctor/slot) and for the no-refund rule (§17). Reusing a no-show seat for a walk-in is a later feature.
- **Audit:** every attendance change records actor + timestamp (§20), so "who marked this no-show" is always answerable.
- COMPLETED and NO_SHOW are terminal attendance states.
- **An unpaid pay-at-clinic payment must be settled or voided before the visit is closed.** Submitting `COMPLETED` or `NO_SHOW` while the appointment still has a `PENDING` payment is rejected by the backend; the desk marks the payment `PAID` (with the collected amount and method) or `VOIDED` in the same action. This is request-level validation, not a background job, so a completed visit can never leave an unclosed receivable on the books (§17, §24).

---

# 14. Appointment Rescheduling

Patients may reschedule their appointment.

Rules:

- New slot must be valid.
- New slot must be within booking horizon.
- New slot must have available capacity.
- Patient-initiated rescheduling follows the cancellation cutoff (§8.5).
- Old slot capacity must be released appropriately.
- Existing appointment history must remain auditable.
- Server must perform all checks.
- Concurrent booking must be handled safely.

Admin/doctor rescheduling may have broader permissions.

**Scope (locked — same doctor only for patients):** a patient may move an appointment to another slot of the **same doctor**, and to no other. Switching to a different doctor is **not** a reschedule — at the desk that is one real-world action, but in the data it is a cancellation (with the §17 refund rules) plus a new booking, which keeps the fee, the queue position and the refund classification unambiguous. STAFF/ADMIN may move a patient **across** doctors (audited, with a mandatory reason, same cutoff rules), because refusing it at the front desk would just push staff into fake cancel-and-rebook.

**Price delta is settled on reschedule:** an appointment carries a **booking-time snapshot** of the doctor's fee (`feeAmount`, alongside the `doctorName` snapshot — §24), so a later fee change never rewrites what the patient agreed to. On reschedule, `delta = newSlotDoctorFee − feeAmount`:

- `delta = 0` → nothing to do.
- `delta > 0` (moving to a more expensive slot/doctor) → the patient **pays the difference through the normal payment flow before the move commits**; the move is rejected if payment is not completed.
- `delta < 0` (moving to a cheaper slot/doctor) → the **difference is refunded automatically** as an unambiguous price correction (§17 case 1: clinic-agreed change, no dispute), against the booking-time `feeAmount` snapshot so the arithmetic is never re-derived from a current fee. It is not routed through the admin queue; there is nothing for an admin to decide.
- Every delta is written to `AppointmentHistory` and to the payment trail, so the money side of a reschedule is as auditable as the seat side.

The authoritative fee is already locked in §3.2 (a clinic-level `defaultConsultationFee`, paise, INR) and §24 (a nullable per-doctor `consultationFee` override); the order is checked against that locked value in §17.

**Row model (locked):** a reschedule **moves the existing appointment** to the new slot — the same row, same history, with the old→new slot recorded in `AppointmentHistory` as a `RESCHEDULED` event. It does **not** create a second appointment row, so the §15 same-slot partial unique index and the per-patient active cap keep working unchanged, and a patient's appointment list never shows a dead predecessor. `RESCHEDULED` is a **history event type, not an appointment status** (see §13).

---

# 15. Concurrency and Double Booking

This is a critical backend requirement.

Example:

Capacity = 5

Current bookings = 4

Two users attempt to book simultaneously.

The system must not accidentally create two bookings that violate capacity.

Use appropriate PostgreSQL transactions, constraints, and locking/concurrency strategy.

**Atomic conditional update (the last-seat guard):** seat consumption for a booking, and hold creation/decrement, use a single conditional statement — no read-then-write gap:

```sql
UPDATE slots SET booked_count = booked_count + 1
WHERE id = $1 AND booked_count + held_count < max_patients;
```

Zero rows affected ⇒ the slot is full, surfaced as a clean "slot full" error. When logic must read values before deciding (e.g. reschedule, or a deliberate raise of `maxPatients`, §8.3), lock the slot row with `SELECT ... FOR UPDATE` inside a transaction.

A **database CHECK constraint** (`booked_count + held_count <= max_patients`) is added as a final safety net so even a code bug cannot overbook.

**Same-slot duplicate rule:** a patient can have at most **one active booking per slot** — enforced with a partial unique index `UNIQUE (patientId, slotId) WHERE status IN (CONFIRMED, ARRIVED)` (`PENDING` is absent because no appointment is ever written as `PENDING` — §13, §8.6). Cancelled / REJECTED / COMPLETED / NO_SHOW rows never count.

**The per-patient cap counts holds too (locked — this is the rule):** a patient may hold at most `maxActiveBookingsPerPatient` (default **3**, §3.2) **seats in total across confirmed bookings and live holds**:

```
activeBookings (CONFIRMED + ARRIVED) + activeHolds (SeatHold where releasedAt IS NULL AND expiresAt > now())
    < maxActiveBookingsPerPatient
```

Counting only bookings would let a patient sit on 3 confirmed seats *plus* a held 4th, because §8.6 caps holds separately at 1. Both numbers are evaluated **inside the same transaction** that creates the hold or the appointment, and that transaction takes `SELECT ... FOR UPDATE` on the patient's own row first — serializing concurrent attempts by the same patient, so two simultaneous requests cannot both pass the check. The separate "1 active hold" rule (§8.6) still applies on top; it is what stops one patient parking several seats while a payment is in flight.

This must be covered by tests.

Reservations (holds) participate in the same capacity invariant: `booked + held` must never exceed `maxPatients`, so the hold/decrement operations use the same atomic guards (§8.6, §17).

Normal application logic should prevent:

6 / 5

unless `maxPatients` was deliberately raised first (§8.3) — there is no separate override mechanism.

---

# 16. Patient Visit History (Returning-Patient Lookup)

Admin and staff can check whether a patient has visited the clinic before. This gives the front desk context when a patient arrives or books (walk-in/phone) without building a discount or loyalty system.

**Matching:**

- Phone number is the primary key (normalized, unique — see §24).
- Email is secondary.
- Name is a search/display hint only and is never the identity key (names collide).

**Displayed:**

- Returning patient? Yes/No (has ≥ 1 COMPLETED appointment)
- Completed appointments count and last visit date
- Upcoming bookings count
- No-show count (from §13.1)
- Doctor(s) seen (optional)

**Access:**

- ADMIN and STAFF only. Doctors do not get this lookup.
- Access is audited (who looked up which patient).
- Only operational summary data is shown — not full medical history.

"Came before" means at least one COMPLETED appointment. Cancelled and NO_SHOW appointments do not count.

**Walk-in / phone patients (locked — the desk path).** This section is also how a patient who has never registered enters the system, and it resolves a genuine conflict: §6.3 blocks *self-registration* booking until the email is verified, but a person standing at the counter cannot be asked to verify an email before being treated.

- **Staff create-or-find by normalized phone (E.164) at the desk.** The same normalization is used by patient registration and by this lookup, so one person is never two rows. An existing patient is found (this section); an unknown number creates a new **provisional** record with just the name and phone.
- **A provisional patient needs no login and no email in MVP.** The record carries `isProvisional = true` and a null `email` (permitted because the §6.4/§24 `UNIQUE` constraint on email allows multiple nulls). The §6.3 verification gate applies **only to self-registration** — a staff-created desk booking is exempt, because staff have already identified the person in person.
- **Everything about a provisional patient is managed by staff at the desk:** book, reschedule, cancel, mark attendance, collect payment. The patient-facing dashboard simply does not show them, because they cannot log in.
- The booking proceeds immediately as **pay-at-clinic** (§17), which needs no payment account. Converting a provisional patient into a real account (claiming a claim-link email, setting a password) is **optional and deferred** (§42) — it is a convenience, not a prerequisite, and nothing in the booking or history flow depends on it. If the patient later gives an email at the desk, staff attach it then, subject to the §6.4 uniqueness check.
- Staff creation of a provisional patient is audited like any other patient write (actor, phone, timestamp), and the §16 lookup audit covers the history view.

Discount/concession rules are explicitly out of MVP scope (see §42). If the clinic wants to give a concession, staff collect the lower amount and record it in the offline payment (§17).

---

# 17. Payment System

Use Razorpay.

Support:

1. Online payment
2. Pay at clinic

Keep appointment status and payment status separate.

Example:

Appointment:

CONFIRMED

Payment:

PENDING

This is valid for pay-at-clinic.

For online payment, the seat is reserved first, the money is taken second:

1. Patient picks a slot → server atomically reserves the seat by creating a **`SeatHold`** (§8.6) and a local `PENDING` payment order, in one transaction. The transaction checks the per-patient cap **with that hold included** (§15) **and the same-slot rule** (§15) — a patient who already has an active booking in that slot is rejected up front with "you already have a booking in this slot", rather than discovering it after paying. **No appointment row is created here.**
2. Client completes the Razorpay flow.
3. Backend verifies the payment signature (order id + payment id + secret) server-side.
4. Backend re-checks that the hold is still valid (`releasedAt IS NULL AND expiresAt > now()`).
5. **Hold valid → one transaction converts the hold into a booking:** the guarded seat update below, `releasedAt = now() / CONVERTED` on the hold, the `Appointment` row **created** as `CONFIRMED` (its queue position is a rank computed from booking time, §8.1 — not a counter returned by the update, which only moves seat counts), and the payment marked `PAID`. All of it commits together or not at all.
6. **Any rejection in step 5 → no appointment is created and the payment is fully auto-refunded**, with a clear message to the patient. This covers *every* failure cause, not only an expired hold: the guarded update affecting zero rows, the same-slot partial unique index (§15), the `booked + held <= maxPatients` CHECK (§15), or a serialization failure. Step 5 is all-or-nothing, so a rolled-back conversion means the money is captured but no seat was consumed — leaving that money un-refunded would be a real loss to the patient, and the hold's own expiry does **not** help, because the money has already left their account. The refund path is therefore the single handler for every step-5 rejection, and each one is covered by a §33 test.

The conversion statement in step 5 is the same last-seat guard as §15, moving a seat from *held* to *booked* in one shot:

```sql
UPDATE slots SET held_count = held_count - 1, booked_count = booked_count + 1
WHERE id = $1 AND held_count > 0;
```

Zero rows affected → the hold is no longer valid → fall through to step 6. This ordering is what makes the flow safe: **the appointment only ever comes into existence at the moment the seat is genuinely consumed**, so there is no window in which a phantom booking can block a patient (§13).

## Seat hold (reservation)

- An online booking creates a **`SeatHold` row** that reserves capacity for **10 minutes** (configurable) — never an `Appointment` row (§8.6, §13).
- While the hold is active the seat counts as taken: capacity rule is `booked + held < maxPatients`.
- The reserve operation must be atomic and concurrency-safe (conditional update on remaining capacity; zero rows affected → "slot full").
- Hold released on: payment success (converted), payment failure, patient abandons/cancels the flow, 10-minute expiry, or account deletion (§6.1). Release always writes `releasedAt` + `releaseReason` — holds are never deleted, so a released seat is provably free (§8.6).
- A patient may have at most **1 active hold** at a time to prevent seat squatting, and at most `maxActiveBookingsPerPatient` seats in total counting bookings **and** holds (§15).
- A late payment after expiry is detected at verification time and triggers an automatic refund.

## Pay-at-clinic

Pay-at-clinic has no money upfront, so no hold is needed: the booking is created immediately as CONFIRMED (a normal capacity booking).

**Offline payment collection (desk):**

- The appointment's Payment row starts `PENDING`. STAFF marks it `PAID` when money is collected, recording: `amount`, `method` (cash / card / UPI), `actor`, `timestamp`.
- Same Payment model and audit/history path as online — cash and UPI are on the books and reconcilable, not off-the-books.
- Concessions: if a lower amount is collected, record the actual collected amount and method (see §16 note); no formal discount feature.
- Cancelled **before** collection → the `PENDING` payment is `VOIDED`, nothing to refund.
- **Paid offline, then cancelled** → classified by the §17 refund table: clinic-caused or in-window cancellations are settled by the desk as a recorded, audited hand-back against a refund record; only the dispute cases go to the admin queue.
- No separate cash ledger — the Payment table (amount, method, status, actor, timestamp) is the single record for both channels.

Never trust payment success solely from frontend input.

Payment verification must occur server-side.

The payment layer should be abstracted enough that another provider could theoretically be introduced later.

## Payment status (locked — this is the enum)

```
Payment.status = PENDING | PAID | FAILED | VOIDED
Refund.status  = PENDING | SUCCESS | FAILED
```

- `PENDING` — created, money not yet collected (a live hold's order, or a pay-at-clinic booking not yet paid at the desk).
- `PAID` — money is collected. This is the **only** success value for a payment; the word `SUCCESS` is refund vocabulary and must never be written to a `Payment` row.
- `FAILED` — collection was attempted and did not succeed (gateway decline, or a gateway call that never returned an order).
- `VOIDED` — closed without money moving. Used for a pay-at-clinic payment closed on cancellation before collection, and for a hold's order when the patient abandons or deletes their account (§6.1). `VOIDED` replaces the earlier ambiguous `CLOSED`.

Both enums are declared here because the rest of the plan references them from several sections; amounts are stored as **integer minor units (paise)**, never floats, and `currency` is `INR` for the single clinic (§3.2).

## Payment verification & idempotency

Two problems are solved together: the client lying about payment, and the same success event arriving twice.

**Server-side signature verification (Problem A — client lies):**

1. Backend creates the order with Razorpay (`order_id`, amount).
2. Client runs the Razorpay checkout and receives `order_id + payment_id + signature`.
3. Backend recomputes the expected signature using the secret key: `HMAC_SHA256(secret, order_id + "|" + payment_id)`. A match means the payment is genuine; a mismatch → reject.
4. Backend re-fetches the payment from Razorpay and confirms `amount`/`currency` match the order (prevents amount tampering).
5. **Webhooks are also signed by Razorpay** — verify the webhook signature too so a fake "payment successful" POST is never trusted.

**Idempotency (Problem B — duplicate events):**

1. Each payment has a natural unique key: `order_id` (tied to its hold) — enforced with a **database `UNIQUE` constraint**, not just code.
2. The verify handler is an **atomic insert-if-not-exists**:
   - Row for this `order_id` already `PAID` → return the stored result, do nothing.
   - Not present → create it and atomically transition `PENDING → PAID`, **converting the hold into a new `CONFIRMED` appointment** (§17 step 5) — exactly once.
3. The same unique-key pattern extends to **refunds**: a unique refund key per payment prevents double-refund on retries.
4. Retried webhooks, client retries, double-clicks, and refresh resubmits all converge to one processed event.

**Stored payment metadata:** `payment_id`, `order_id`, `amount`, `currency`, `status`, `paidAt`, plus the raw Razorpay payload (for reconciliation and the refund flow).

## Refunds

Refund policy follows the principle: **who caused the cancellation, and was it within the cancel window?**

| Scenario | Refund? |
|---|---|
| Patient cancels before cutoff (1 h before slot, §8.5) | Full refund — seat was returned early |
| Patient cancels after cutoff | No refund — seat wasted |
| Patient no-shows | No refund — seat wasted |
| Clinic cancels (doctor unavailable / clinic issue) | Full refund — clinic caused it |
| Reschedule to a cheaper slot/doctor (§14) | Refund of the fee difference — clinic-agreed change |
| Paid but hold expired (>10 min) | Full refund, automatic (§8.6) |

**MVP implementation — auto-refund the clear cases, queue only the disputes:**

A small clinic does not hand every refund to an admin, and forcing it to do so is how refunds get forgotten until a patient complains. The default is therefore **automatic**, and human review is reserved for cases where the answer is genuinely a judgement call.

**1. Refund automatically, no approval needed** (`refund.status = SUCCESS`, executed by the backend, audited with the triggering actor + reason):

- Clinic-caused cancellation of a paid booking — doctor unavailable (§12), suspension/archive cascade (§5.2), or a disabled slot's patients after §8.4 reschedule/cancel. The clinic caused it; the patient is not in dispute.
- Patient cancellation **at or before** the cutoff (§8.5) — the seat was returned in good time.
- A **reschedule to a cheaper slot/doctor** (§14): the difference is refunded against the booking-time `feeAmount` snapshot. The patient and clinic already agreed to the change, so the arithmetic is not a judgement call and there is nothing for an admin to decide.
- Any step-5 conversion failure (§17) or a hold that expired before payment verified.

**2. Create a refund request for the admin queue** — these are the only cases needing a decision:

- Patient cancellation **after** the cutoff, where the patient contests it ("I cancelled as soon as I saw the message").
- `NO_SHOW` (no refund by policy, §13.1) where the patient disputes it.
- Any refund where the collected amount is disputed (a concession recorded against the booking-time `feeAmount`, §14).
- A gateway refund that returned `FAILED` — the queue shows it and offers a **retry**, made safe by the unique refund key per payment, so a double-click cannot double-refund.

**3. Gateway vs offline (one record, two settlement paths):** a refund is a first-class record either way — original `paymentId`, `amount`, `status` (`PENDING → SUCCESS | FAILED`), `reason`, `actor`, `timestamp`, `gatewayRefundId`. For an online payment the backend calls Razorpay and the refund completes unattended. For a **pay-at-clinic** payment there is no gateway call at all — a human has to physically hand the money back, so the refund record is created as `PENDING` and the desk closes it out by recording the hand-back (`method` cash/UPI, actual amount, actor, timestamp), leaving `gatewayRefundId` null. Those pending desk hand-backs are listed on the **staff** dashboard next to the refund requests — staff are the ones who must physically return the money, so the task is on the role that can complete it (they need no decision, only completing), and admin sees only the disputes, and **the clinic absorbs gateway fees.**

**4. Rejections** are notified to the patient with the admin's stated reason.

**Clinic-caused cancellations follow reschedule-first:** notify the patient, suggest the nearest available slot; refund automatically if the patient declines or does not respond (§12).

*Post-MVP:* fraud-pattern detection (repeated cancel→refund) and richer approval rules. The refund service keeps "who decided" as an explicit field, so a rule-based approver can replace the human one without changing the record.

---

# 18. Notifications

Use Resend for transactional email.

Production-oriented notification architecture:

Business Event
→ Notification Service
→ Email Job/Processing
→ Resend

Required notification events include:

**Auth & account (§6):**
- Registration email verification (link or OTP, §6.3)
- Account invitation to claim (admin → staff, admin/staff → doctor, §5.1)
- Email-change verification link (sent to the new email, §6.1)
- Password reset requested (link or OTP, §6.2)
- Password reset completed (§6.2)
- Security notice when all sessions are revoked by an admin action (§6.3)
- Account deleted / deactivated confirmation (patient, §6.1)

**Doctor management (§5):**
- Doctor verified → email to the doctor (§5)
- Doctor suspended or archived → email to the doctor (§5.2)
- Doctor added / updated / suspended / archived by STAFF → admin notification (§5.2)

**Appointments (§8, §12–§14):**
- Appointment booked (which is also the confirmation — an appointment is born `CONFIRMED`, §13, so there is no separate confirm step). For an online booking this fires at **payment verification**, when the appointment row is actually created (§8.6, §17), not when the hold is taken; a pay-at-clinic booking fires it immediately
- Appointment rejected
- Appointment cancelled (patient / clinic)
- Appointment rescheduled
- Doctor unavailable → affected patients (§12)
- Appointment auto-cancelled (doctor unavailability / offboarding, §12)

**Payments & refunds (§17):**
- Payment successful (receipt)
- Payment failure where appropriate
- Late-payment auto-refund (§8.6 / §17)
- **Every refund that completes — automatic or admin-approved — notifies the patient** that the money is coming back, with the amount and the reason. This is emitted by the refund path itself when `refund.status` reaches `SUCCESS`, not by a human remembering, because the large majority of refunds in MVP are automatic (§17 case 1) and an unannounced refund is indistinguishable from a lost payment.
- Refund request raised → admin notification (review queue, §17)
- Refund rejected → patient (with admin reason, §17)

**Reminders (§18):**
- One reminder, **2 h before slot start**

*(MVP sends one reminder, not a day-before + morning-of + 2 h sequence. Repeated reminders are the classic driver of both no-shows and spam complaints, and they cannot be tuned without delivery data the clinic does not yet have. The reminder anchor is a config value, so adding more later is a list, not a redesign.)*

**Deferred (post-MVP, §42):**
- Walk-in / phone patient claim email — a provisional desk record does not need a login in MVP (§16), so there is nothing to claim until that is wanted.

**Every send is recorded, once.** A `Notification` row is written per send with `type`, `recipient`, `appointmentId?`, `status` (`PENDING | SENT | FAILED`), `sentAt`, and the provider error if it failed. Two things follow, and they are the only reliability requirements in MVP: a reminder is **never sent twice** for the same appointment (the row's existence is the dedupe key, so a job re-run cannot double-send), and a failed send is **visible** to a human instead of vanishing. There is no retry queue, no backoff and no attempt counter — a job queue is post-MVP (§42) — because a single-clinic app can re-send by hand from the row, and a send that failed twice will not succeed on the tenth try.

## Appointment reminders

There is no per-patient appointment time (§9), so the reminder anchors to the **slot start**.

**One reminder: 2 hours before the slot starts.**

The reminder may include the queue position ("you are #4 of 15") instead of a time. It is sent to the registered email (§6.3 — no SMS in MVP). Provisional desk patients receive no reminder, since they have no email (§16).

**How it runs (locked for MVP):** reminders, hold expiry, the §12 auto-cancel and slot generation are **in-process scheduled jobs in the single Node server** — a plain interval timer, no external queue, no Redis, no separate worker process. **The startup sweep runs once when the process boots, before it serves traffic**, so a restart can never leave an expired hold blocking a patient (§8.6) (§42 keeps those post-MVP; §43 forbids Redis without a demonstrated requirement). A reminder send must never block an HTTP request. The consequence to accept: with one server instance, jobs run only while the process is running, so a laptop that is asleep misses its window and the reminder is not sent late — it is simply not sent, and the `Notification` row shows why. That is the correct trade at this scale; a durable queue earns its cost only when reminders must survive restarts.

---

# 19. Logging / Observability

Use Pino if compatible with the final Node/Express setup.

Prefer structured logs over random console.log statements.

Useful fields:

- timestamp
- request ID (single middleware assigns one per request; propagated through all logs and echoed in error responses, §32)
- user ID where appropriate
- route
- HTTP method
- status code
- duration
- error information
- relevant service/event information

Do not log:

- passwords
- JWT secrets
- refresh tokens
- sensitive payment secrets
- unnecessary personal data

---

# 20. Audit Logging

Implement an audit log system for important administrative/business actions.

Examples:

- Doctor verification
- Doctor suspension
- Doctor create / update / archive
- Doctor credential edits that reset verification to `PENDING_VERIFICATION` (§5.2)
- Staff deactivation (§5.1)
- Slot capacity changes (mandatory reason)
- Other slot/schedule edits (mandatory reason)
- Patient visit history lookups
- Appointment administrative changes
- Doctor unavailability actions
- Attendance changes (check-in, complete, no-show)
- Important payment/admin operations

Example audit record:

actor:
admin_123

action:
APPOINTMENT_CAPACITY_CHANGE

target:
slot_456

reason:
"Emergency patient referred by existing patient."

timestamp:
...

Audit records are **append-only**: a row is created once and can **never be updated or deleted** — by any application role, including admin. There is no edit/delete API, and the application's data-access layer for audit tables exposes insert-and-read only — enforced by convention, by the absence of any edit/delete route, and by a test asserting that an update or delete through the application fails. This protects the record from UI misuse and from an ordinary application bug. *(Enforcing it additionally with database `REVOKE` grants is a deployment-hardening option for later, deferred to §42 — it is not required in MVP, because it is invisible to every user and a single wrong `REVOKE` breaks the running app.)*

Every audit row records: `actor` (id + role + a **name snapshot captured at action time** — renaming an actor later never rewrites attribution), `action`, `target`, `before`/`after`, `reason`, `ip`, request id, `timestamp`.

---

# 21. Validation

Use Zod for runtime validation.

Validate:

- Request bodies
- Query parameters
- Route parameters where appropriate
- Authentication-related input
- Appointment creation
- Schedule configuration
- Payment-related input
- Profile updates

Do not rely on TypeScript alone.

TypeScript provides compile-time guarantees.

Zod provides runtime validation for external input.

---

# 22. Security

Implement at minimum:

- bcrypt password hashing
- JWT authentication
- Secure HTTP-only cookies where appropriate
- RBAC
- Ownership checks
- Input validation with Zod
- Helmet
- CORS configuration
- Rate limiting
- DB-backed login/OTP lockout (§6.3)
- Refresh-token rotation + immediate session revocation (§6.3)
- Secure environment variables
- Centralized error handling
- Error sanitization
- Database constraints
- Parameterized/ORM database operations
- Payment verification
- Audit logging

Evaluate CSRF protection based on the final cookie/authentication design.

Never expose secrets through source code.

Provide `.env.example` but never commit real credentials.

---

# 23. Database / Prisma

Use Prisma ORM with PostgreSQL.

Learn and implement migrations properly.

Expected learning flow:

Prisma schema
→ migration
→ generated SQL/database change
→ PostgreSQL

Database design should include appropriate:

- Primary keys
- Foreign keys
- Unique constraints
- Check constraints where appropriate
- Indexes
- Timestamps
- All timestamps stored in UTC; displayed in clinic-local time via the single Clinic timezone config (§3.2)
- Soft-delete strategy where justified
- Audit relationships
- Documented `pg_dump` backup / restore commands maintained as part of local operations (§38)

**Constraints Prisma cannot express, so hand-written SQL migration is required (locked).** Three of the correctness rules in this plan are constraints Prisma's schema language has no syntax for, and they must not be quietly dropped because the ORM cannot express them:

| Constraint | Where it is specified |
|---|---|
| `UNIQUE (patientId) WHERE releasedAt IS NULL` on `SeatHold` — one live hold per patient | §8.6, §15 |
| `UNIQUE (patientId, slotId) WHERE status IN ('CONFIRMED','ARRIVED')` on `Appointment` — one active booking per patient per slot | §15 |
| `CHECK (bookedCount + heldCount <= maxPatients)` on `Slot`, plus `CHECK (maxPatients > 0)` | §8.1, §15 |

These are written as an edited, hand-reviewed SQL migration after `prisma migrate dev` generates the base tables, and §33's test cases assert the database actually rejects the violating write — a passing ORM migration is not evidence that these three rules exist. Everything else stays in the Prisma schema.

Avoid over-normalization or unnecessary abstraction.

---

# 24. Likely Core Entities

The exact schema must be designed and reviewed before implementation.

Likely entities include:

- Clinic (single record holding configuration)
- User (`role`; `email` — **UNIQUE across every account type**, nullable only for provisional desk patients, §6.4/§16; `passwordHash` — **nullable**, because §5.1 forbids a temporary password and the first admin plus every doctor/staff account is claimed via the §6.2 reset flow, so a null hash is the normal "not yet claimed" state and must always fail login)
- PatientProfile (with unique normalized phone — the identity key, §16; `isProvisional` for desk-created patients; email / emailVerified / phoneVerified flags)
- RefreshToken (`userId`, `tokenHash` unique, `expiresAt`, `revokedAt` — no `familyId`, §6.3)
- AuthAttempt
- DoctorProfile (`verificationStatus` = `INVITED | PENDING_VERIFICATION | VERIFIED | REJECTED | ARCHIVED` plus **orthogonal** `suspendedAt?` / `suspendReason?` — never an `ACTIVE`/`SUSPENDED` enum value, §5; `qualification`, `licenseNumber`, `experience`, `clinicAssociation`, and `specialization` — **free text, §30** — which are the verification-impacting fields that force re-verification when edited, §5.2; `consultationFee` — nullable, falling back to the Clinic default — required by the §14 reschedule delta)
- Staff relationship
- Schedule (weekly availability template; materializes concrete dated Slots across the booking horizon, §10/§11)
- Slot (one availability window: `slotDate` + `startTime`/`endTime` + `startAt`/`endAt` (derived from date + time and stored, §8.1), `maxPatients`, `bookedCount`, `heldCount`; a slot = one doctor session, not a sub-interval — §8.1)
- **SeatHold** (`id`, `slotId`, `patientId`, `paymentOrderId?`, `appointmentId?`, `createdAt`, `expiresAt` = `min(now + holdDuration, slot.startAt)`, `releasedAt?`, `releaseReason?`) — the **single source of truth for "seat reserved, not yet booked"** and the only trace of an unfinished online booking (§8.6, §13, §17). Constraints: `UNIQUE (slotId, patientId) WHERE releasedAt IS NULL` (one live hold per patient per slot) and `UNIQUE (patientId) WHERE releasedAt IS NULL` (the §8.6 one-hold rule). `heldCount` on the Slot must always equal the number of rows with `releasedAt IS NULL`.
- Appointment (with partial unique index: one active booking per patient per slot — §15; plus booking-time snapshots `doctorName` and `feeAmount` so later fee/name changes never rewrite what the patient saw or agreed to pay — §14; `status` per the §13 transition matrix)
- AppointmentHistory (append-only per-appointment event timeline: eventType, from/to, actor, metadata — §13, §17)
- Payment (`status` = `PENDING | PAID | FAILED | VOIDED`, amount as integer paise, `currency` = INR, `orderId?`/`paymentId?`, `method`, `paidAt?` — enum declared in §17)
- Refund (`paymentId`, `amount`, `status` = `PENDING | SUCCESS | FAILED`, `reason`, `actor`, `timestamp`, `gatewayRefundId?` — also the **offline hand-back record** for pay-at-clinic money, §17)
- Notification (one row per send: `type`, `recipient`, `appointmentId?`, `status` = `PENDING | SENT | FAILED`, `sentAt?`, error — also the reminder dedupe key, §18)
- AuditLog (append-only, §20)
- DoctorUnavailability
- DoctorHistory (append-only per-doctor lifecycle/profile timeline: eventType, from/to, actor, metadata — §5.2)

DB constraints include a CHECK on Slot: `booked_count + held_count <= max_patients` (§15).

Do not blindly implement every entity. Confirm whether each entity is required after mapping actual relationships.

---

# 25. Frontend Architecture

Suggested structure:

client/
- src/
  - components/
  - pages/
  - layouts/
  - features/
  - hooks/
  - services/
  - lib/
  - context/
  - routes/
  - types/
  - schemas/

Use feature-oriented organization where it improves maintainability.

Use:

- TanStack Query for server state
- Context API for appropriate global client state
- Local React state for local UI state

Do not introduce Redux/Zustand unless the application develops a genuine need for them.

---

# 26. Public Website

Landing page should include:

- Clinic introduction
- Public doctor list
- Specializations
- Doctor cards
- Doctor profiles
- Appointment booking entry points
- Public clinic statistics where appropriate
- Relevant trust/information sections
- Responsive design

Booking should be available from individual doctor sections.

Public statistics must be truthful and derived from real data or clearly identified as configured clinic statistics.

Do not fabricate success metrics.

---

# 27. Patient Dashboard

Include:

- Dashboard overview
- Find doctors
- Browse doctors by specialization
- Doctor profiles
- Available slots
- Upcoming appointments
- Past appointments
- Appointment cancellation
- Appointment rescheduling
- Payment information where appropriate
- Profile management
- Update email / mobile number (with verification, §6.1)
- Delete account (§6.1)

Patients must only manage their own data.

---

# 28. Doctor Dashboard

Include:

- Dashboard overview
- Upcoming appointments
- Appointment history
- Schedule
- Availability
- Mark unavailable periods
- Profile
- Relevant appointment/patient information
- Live queue view for today's slots — read-only: per-slot queue in booking order (name + masked contact + status), ARRIVED/NO_SHOW/COMPLETED flags, "up next" highlighted; attendance is set only by ADMIN/STAFF (§13.1)

Potential future additions:

- Consultation notes
- Prescription management
- Earnings/reports

These should not be added to MVP unless they are required.

---

# 29. Admin and Staff Dashboards

## Admin Dashboard

Include:

- Overview/statistics
- Doctors
- Add/invite doctors
- Doctor verification
- Doctor availability
- Patients
- Appointments
- Attendance / check-in (today's slots, queue, ARRIVED / COMPLETED / NO_SHOW)
- Schedule management
- Slot management
- Capacity changes (audited reason)
- Patient visit history lookup (returning-patient)
- Refund review queue — disputes and retried gateway refunds only; unambiguous cases refund automatically (§17)
- Payments
- Notifications where useful
- Audit logs
- Admin profile

Admin has the highest application-level control.

## Staff Dashboard (front desk)

Include:

- Today's slots and live queue
- Check patients in (ARRIVED)
- Mark COMPLETED / NO_SHOW after the slot
- Appointment management (create walk-in/phone bookings, cancel, reschedule)
- Create/invite, update, suspend, and archive doctors (verification and un-archive stay admin-only, §5.2)
- Slot management and capacity changes (audited reason)
- Doctor unavailability
- Record offline (pay-at-clinic) payments
- Patient visit history lookup (returning-patient)
- Refund requests raised for pay-at-clinic payments — i.e. the staff-settlable list, not the admin dispute queue (§17)
- Pending cash/UPI hand-backs for refunded pay-at-clinic payments — no decision needed, just record the money returned (§17)

Staff are scoped to the single clinic.

---

# 30. Specialization (no Department entity in MVP)

Patients browse and filter doctors by **specialization** — for example Cardiology, Dermatology, Orthopedics, Pediatrics.

- **A free-text `specialization` field on the doctor profile** is the whole feature. There is no `Department` table, no `DoctorDepartment` join and no department admin screen in MVP.
- **Why:** a department entity only earns its keep when departments need their own data (a description page, a head, a per-department schedule or fee). This clinic has one location, a handful of doctors, and no such requirement — a join table and its CRUD screens would be pure ceremony. The filter itself is `WHERE specialization = ?`.
- The cost of the simplification is known and accepted: the list of specialties is whatever doctors type, so it can contain near-duplicates ("Cardiology" vs "Cardiologist"). For a single clinic that is a cosmetic data-cleanliness task, fixable at any time.
- *If departments ever need real records, add a `Department` table and backfill from the existing distinct `specialization` values — a strictly additive change, which is exactly why the field is free text now rather than an enum.*

---

# 31. API Versioning

Use versioned REST APIs:

`/api/v1/...`

Initial resource groups may include:

- `/api/v1/auth`
- `/api/v1/clinics`
- `/api/v1/doctors` (incl. `/me/queue/today` — read-only live queue, §28)
- `/api/v1/patients`
- `/api/v1/schedules`
- `/api/v1/slots` (incl. bulk week create, §11)
- `/api/v1/appointments`
- `/api/v1/payments`
- `/api/v1/notifications`
- `/api/v1/admin`

Exact endpoints must be designed from use cases rather than generated blindly.

---

# 32. API Response Strategy

Core REST APIs use JSON.

Do not replace JSON with TOON.

TOON is a possible future AI/LLM serialization experiment.

API responses should have consistent success/error structures.

Example concept:

Success:
- data
- metadata where required

Error:
- error code
- message
- validation details where safe
- request ID (always included, matches logs §19)

Do not leak stack traces or internal implementation details to clients.

---

# 33. Testing Strategy

Prioritize critical business flows.

Test:

### Authentication
- Registration
- Login
- Refresh
- Logout
- Unauthorized access
- Update email/phone requires verification + uniqueness check
- Phone change in MVP: no phone-OTP flow exists; the change requires the authenticated email-verified session + re-auth, is E.164-normalized and uniqueness-checked, and lands as `phone_unverified` (§6.1)
- Email uniqueness: an invitation sent to an address already registered on any account cannot be claimed — never auto-linked, never auto-merged (§6.4)
- Access token of a suspended / archived / deactivated account is rejected by the per-request status re-check (§6.3)
- Delete account → deactivated/anonymized; blocked with upcoming appointments or pending payments
- Delete account with an active hold → hold atomically released (seat freed), pending order voided, then deactivation + anonymization; a guarding failure rolls back the whole delete
- Delete account → late racing payment after delete commits is rejected and auto-refunded (§17, no valid hold)
- Forgot password — email reset link method: valid link opens portal; expired/used link rejected
- Forgot password — email OTP method: valid OTP opens portal; wrong/expired/used OTP rejected
- User can choose between link and OTP methods
- Reset only allowed for registered emails (generic response, no account enumeration)
- Successful reset invalidates existing sessions/refresh tokens
- Login/OTP rate limiting: lockout after repeated failures (identity + IP keyed)
- Refresh-token rotation: the previous token is invalid after use; revoking every session logs the account out everywhere immediately (§6.3)
- Registration email verification: unverified account cannot book

### Authorization
- Patient cannot access another patient's data
- Doctor cannot perform admin operations
- Patient cannot perform doctor/admin actions
- Admin permissions
- Staff cannot add staff or change any role (provisioning rules, §5.1)
- Staff can create/update/suspend/archive doctors but cannot verify, un-archive, or hard-delete them; every action carries locked audit attribution (§5.2)

### Provisioning & invites
- Bootstrap: first admin created by the setup command; claims the account via the forgot-password flow — no admin self-registration exists
- Admin creates staff → staff claims the account via email link/OTP
- Admin or staff creates/invites a doctor → doctor claims the account and is then verified by admin
- Doctor suspension → login is blocked in the same transaction, every future confirmed booking is auto-notified and auto-cancelled by the §12 cascade (cutoff waived, **automatic** refund per §17 case 1, never `NO_SHOW`), and a concurrent booking for that doctor is rejected even if it read the slot as enabled first (§5.2 race guard)
- Non-patient accounts are only ever created via an invite/claim path (§5.1)
- Staff deactivation: a deactivated staff member cannot log in, live sessions are revoked immediately, and every historical row they authored stays intact and correctly attributed via the name snapshot (§5.1)
- An invitation sent to an already-registered email cannot be claimed — no account takeover through someone else's invite (§6.4)
- Suspending or archiving a doctor revokes live sessions immediately, not at access-token expiry (§5.2, §6.3)
- Editing a verification-impacting credential — by staff, admin, or the doctor — resets the doctor to `PENDING_VERIFICATION`, keeps existing appointments intact, hides the doctor from new bookings, and requires admin re-verification (§5.2)

### Scheduling
- Schedule creation
- Slot creation
- Bulk week setup: whole week created atomically in one request; invalid batch rejected entirely (§11)
- Capacity
- Capacity change requires a reason (missing reason → rejected)
- Lowering capacity below `bookedCount + heldCount` → rejected (a live hold blocks the lowering, because a hold is a promise of a seat)
- Booking horizon
- Schedule modification
- Doctor unavailability
- Editing a slot's date/times while it holds an active booking **or a live hold** → rejected (§8.4)
- Disabling or removing a slot while it holds an active booking **or a live hold** → rejected; after the patients are rescheduled/cancelled it succeeds, audited (§8.4)
- A booking into a window overlapping a `DoctorUnavailability` → rejected; the slot does not appear in availability (§11)
- Slot generation is idempotent: re-running it for the same horizon creates no duplicates (unique `doctorId + slotDate + startTime`, §8.1)

### Appointment status transitions (§13 matrix — enforced server-side)
- `COMPLETED` directly from `CONFIRMED` (never `ARRIVED`) → rejected
- `NO_SHOW` before the slot `endAt` → rejected; from `ARRIVED` → rejected
- `ARRIVED` before the slot start → rejected
- Any transition out of a terminal state (`COMPLETED`, `NO_SHOW`, `CANCELLED`, `REJECTED`) → rejected, naming the current status
- `REJECTED` without a reason → rejected; with a reason → accepted, history + audit + patient notification written
- The §12 auto-cancel job cancels only rows **still `CONFIRMED`**; an appointment already `COMPLETED` or `NO_SHOW` is left untouched (this is the "attendance is never overwritten" guarantee)
- Marking `COMPLETED`/`NO_SHOW` while a `PENDING` pay-at-clinic payment exists → rejected until it is `PAID` or `VOIDED` (§13.1)

### Appointments
- Booking
- Booking rejected for a slot that has already started (min lead time = 0); slot bookable up to its start time
- Cancellation after 1-hour cutoff → rejected
- Rescheduling
- Reschedule scope: a patient may only move within the same doctor; a cross-doctor move is staff/admin-only and audited, and is never performed as a patient reschedule (§14)
- Reschedule fee delta: a higher-fee target requires payment before the move commits, a lower-fee target is refunded automatically (§17 case 1), and both are recorded in `AppointmentHistory` + the payment trail (§14)
- Check-in (ARRIVED)
- Mark COMPLETED
- Mark NO_SHOW after slot ends
- Doctor cannot change attendance (authorization)
- Doctor today's queue: shows slots, queue order, ARRIVED/NO_SHOW/COMPLETED flags; read-only (attendance modifiers rejected)
- Completion
- Rejection
- Invalid booking

### Concurrency
- Simultaneous booking
- Capacity race conditions
- Atomic last-seat race: N concurrent bookings → exactly one fails with "slot full"
- Concurrent holds use the same conditional guard
- Deliberate `maxPatients` raise (with audited reason, §8.4)
- DB CHECK constraint prevents overbooking even on code bug
- Same-slot duplicate: second active booking for patient+slot rejected (partial unique index)
- One live hold per patient: a second hold is rejected by `UNIQUE (patientId) WHERE releasedAt IS NULL`, and an **expired-but-unreleased** hold is rejected by the in-transaction time re-check rather than by the index (both asserted against the real database, §23)
- Active-booking cap per patient (maxActiveBookingsPerPatient) enforced
- **The cap counts holds as well as bookings:** 3 confirmed + 1 live hold is rejected; the check runs inside the hold/booking transaction and holds a `FOR UPDATE` lock on the patient's row so two concurrent attempts cannot both pass (§15)
- **An expired hold leaves no trace:** after expiry the slot's `held_count` is back, the patient can book that same slot again, and their active-booking count is restored — because no appointment row was ever created (§8.6, §13, §17)
- **Server restart mid-payment:** holds that expired while the server was down are released by the hold-expiry sweep, which runs once at startup before traffic is served (§18), and no patient is left blocked — a stale hold can only ever waste a seat, never lock a patient out (§8.6)
- Hold → booking conversion is all-or-nothing: the appointment is created, the hold marked `CONVERTED`, and the seat moved held→booked in one transaction (§17)
- **Any step-5 rejection after a successful payment produces no appointment and a full automatic refund** — covered for each cause: guarded update affects zero rows, same-slot unique-index violation, `booked + held` CHECK violation, and a serialization failure. Assert in each case that no `Appointment` row exists, the `Payment` stays `PAID` (the money did move, §6.1) with a `Refund` row reaching `SUCCESS`, and the seat is free again (§17 step 6)

### Doctor unavailability
- Affected CONFIRMED appointments identified and notified by email
- No auto-rescheduling occurs anywhere
- Clinic-caused patient cancel → full refund executed automatically; no approval step (§17)
- Cutoff waived for affected appointments until slot start
- No response → auto-cancel after slot end + automatic refund; NO_SHOW never applied
- Reschedule for an affected appointment preserves history

### Payments
- Payment creation
- Verification
- Invalid signature → rejected
- Duplicate success events (retry/webhook) → processed once (idempotent)
- Amount/currency mismatch → rejected
- Failure
- Hold expiry frees the seat; late payment → auto-refund
- An online booking creates **no appointment row** before payment is verified — the attempt is only a `SeatHold`; the appointment is created as `CONFIRMED` at verification, and a late/duplicate verification cannot create a second one (§8.6, §13, §17)
- Released holds are never deleted: `releasedAt` + `releaseReason` is written on every release path (converted / expired / payment failed / account deleted) (§8.6)
- Patient cancellation in-window → automatic refund; after the cutoff → **no refund by default** (seat wasted), and only a refund request if the patient **contests** it (§17 queue case 1)
- Admin approves/rejects refund with reason
- Rejected refund notifies patient
- Pay-at-clinic (immediate booking, no hold)
- Offline collection: staff marks PAID with amount + method + actor; recorded and audited
- Cancel before offline payment → PENDING becomes VOIDED, no refund
- Paid offline then cancelled → desk records the hand-back against a refund record (no gateway call); only a disputed amount goes to the admin queue

### Patient Visit History
- Lookup by phone (primary) and email
- Name-only search does not match identity
- Returning flag based on COMPLETED appointments only
- No-show count shown
- Doctors cannot access the lookup
- Lookup access is audited
- A staff desk booking for an **unknown phone number** creates one provisional patient record, and repeating it finds that same record rather than creating a duplicate (§16)
- A provisional patient with a null email **can** be booked for by staff despite §6.3's email-verification gate; the gate applies to self-registration only
- A provisional patient has no login, so they are absent from the patient dashboard while remaining fully visible in staff/admin views and in §16 history
- Attaching an email to a provisional patient via the desk is rejected when that email is already registered (§6.4)

### Audit log integrity
- Rows are append-only: update/delete API does not exist and the application cannot modify rows
- Capacity-change and unavailability events recorded with actor, before/after, reason, ip, request id

### Appointment history
- Every state change writes an append-only timeline row (booked → paid → confirmed → rescheduled → cancelled/rejected → arrived → completed/no-show)
- RESCHEDULED records old → new slot
- Cancellation records cause (patient / clinic / auto)
- Each row carries actor, role, timestamp, request id; history is viewable role-scoped

### Notifications
- Appointment events
- Reminder eligibility (slot-anchored: exactly one reminder 2 h before slot start; optional queue position in content)
- **Exactly one** `Notification` row and one send per appointment reminder; re-running the reminder job does not re-send (the row is the dedupe key, §18)
- A send that fails records `FAILED` + the provider error on the row instead of vanishing
- A provisional desk patient receives no reminder (no email on file, §16)

---

# 34. Git Strategy

Use Git from the beginning.

Recommended branches:

- main
- develop
- feature/auth
- feature/scheduling
- feature/appointments
- feature/payments
- etc.

Use meaningful commits.

Examples:

- `feat: add patient registration`
- `feat: implement doctor verification`
- `feat: add slot generation`
- `fix: prevent appointment overbooking`
- `test: add appointment capacity tests`
- `refactor: extract scheduling service`

Do not commit:

- `.env`
- secrets
- generated sensitive files
- credentials

---

# 35. Environment Configuration

Use environment variables.

Expected categories:

- Database URL
- JWT secrets
- Resend API key
- Razorpay credentials
- Frontend/backend URLs
- Other service configuration

Provide:

`.env.example`

Never commit actual secrets.

---

# 36. Development Workflow

Before implementation:

1. Inspect existing environment.
2. Confirm Node/npm/Git/PostgreSQL.
3. Establish repository.
4. Initialize frontend/backend structure.
5. Configure TypeScript.
6. Configure linting/formatting.
7. Configure environment handling.
8. Create Prisma/PostgreSQL setup.
9. Generate and review database architecture.
10. Create initial migration.
11. Implement feature phases incrementally.

Do not generate the entire application in one giant operation.

---

# 37. Implementation Phases

## Phase 0 — Project Foundation

- Repository
- Folder structure
- Frontend initialization
- Backend initialization
- TypeScript
- ESLint/formatting
- Environment configuration
- Basic Express server
- React app
- Prisma connection
- PostgreSQL connection
- Basic health endpoint with real DB check (`/health`)

Definition of done:

Frontend and backend run locally and communicate.

---

## Phase 1 — Database and Core Domain

- Prisma schema
- Clinic
- User
- Patient
- Doctor
- Initial relationships
- Migrations
- Seed data
- Basic database indexes/constraints

Definition of done:

Database can be recreated from migrations and seeded reliably.

---

## Phase 2 — Authentication and Authorization

- Patient registration
- Login
- bcrypt
- JWT
- Refresh tokens
- HTTP-only cookie strategy
- Logout
- Forgot password — choose email reset link or email OTP, then set new password (§6.2)
- Authentication hardening — login/OTP lockout, refresh-token rotation, immediate session revocation, email verification (§6.3)
- Patient account management (update email/phone with verification, delete/deactivate account)
- Doctor/admin authentication
- RBAC
- Ownership checks

Definition of done:

Users can authenticate and cannot access unauthorized resources.

---

## Phase 3 — Doctor and Clinic Management

- Clinic profile
- Doctor specializations
- Doctor onboarding
- Doctor verification
- Admin doctor management
- Public doctor profiles
- Doctor dashboard foundation

Definition of done:

Admin can create/manage doctors and verified doctors appear publicly.

---

## Phase 4 — Scheduling Engine

- Schedule configuration
- Working days
- Slot windows (start/end) per working day
- maxPatients per slot
- Slot creation
- Bulk weekly slot setup (set the whole week in one request, audited reason, §11)
- Booking horizon
- Slot availability
- Capacity change with audited reason
- Schedule updates
- Doctor unavailability

Definition of done:

Clinic can configure schedules and patients see only valid bookable slots.

---

## Phase 5 — Appointment Engine

- Booking
- Rejection
- Completion
- Rescheduling
- Capacity enforcement
- Capacity change with audited reason
- Audit logging
- Concurrency handling

Definition of done:

Appointment lifecycle works safely under normal and concurrent requests.

---

## Phase 6 — Payments

- Razorpay integration
- Order/payment creation
- Backend verification
- Payment status
- Pay-at-clinic
- Payment-related appointment rules
- Payment error handling

Definition of done:

Online and pay-at-clinic flows work correctly.

---

## Phase 7 — Notifications

- Resend setup
- Notification service
- Appointment emails
- Cancellation emails
- Booking-confirmation emails (the appointment is born `CONFIRMED`, so there is no confirm action to build — §13, §18)
- Payment emails
- Doctor-unavailability notifications
- Reminder scheduling
- Two-hour reminder

Definition of done:

Notification flows are triggered reliably without coupling email delivery directly to request handling.

---

## Phase 8 — Dashboards and UI Polish

- Public landing page
- Doctor listing
- Specialization browsing
- Patient dashboard
- Doctor dashboard
- Admin dashboard
- Staff (front desk) dashboard
- Responsive UI
- Loading states
- Error states
- Empty states
- Form validation
- Accessibility basics

Definition of done:

The application feels like a cohesive product rather than disconnected technical screens.

---

## Phase 9 — Testing and Hardening

- Unit tests where valuable
- API integration tests
- Authorization tests
- Appointment tests
- Concurrency tests
- Payment tests
- Notification tests
- Security review
- Error handling review
- Logging review
- Database constraint review

Definition of done:

Critical workflows have automated coverage and obvious security/business-rule gaps are addressed.

---

# 38. Local Development Completion Criteria

Before considering localhost MVP complete:

- Patient can register/login.
- Patient can update email (verification link to the new address) and mobile number (re-authenticated session, no SMS in MVP, §6.1), and can delete/deactivate their account (deletion atomically releases active holds and voids their pending orders — no orphaned holds, §6.1).
- Any role can reset a forgotten password via email reset link **or** email OTP (user's choice).
- Auth hardening works: lockout after repeated failed logins/OTPs; revoking every session logs the account out everywhere immediately; new patient registrations verify email before they can book.
- Admin can add/invite doctors, and staff can too (§4, §5.1, §5.2); no doctor self-registration exists.
- Admin can create staff accounts (§5.1).
- Admin can deactivate a departing staff account: login refused and sessions revoked immediately, with all historical rows intact and still attributed to them (§5.1).
- Admin can verify doctors.
- Staff can create/update/suspend/archive doctors with locked audit attribution; verification and un-archive remain admin-only (§5.2).
- Suspending/archiving a doctor with future bookings auto-triggers the §12 patient-notification cascade — no stranded patients — and revokes that doctor's live sessions immediately (§5.2).
- Editing a doctor's qualification / license / specialization / experience / association sends the doctor back to `PENDING_VERIFICATION` for admin re-verification, without touching existing appointments (§5.2).
- Staff/admin can suspend and archive a doctor immediately, and admin can un-suspend / un-archive: every future confirmed booking is notified with a waived cutoff and an automatic refund, login is revoked in the same transaction, and a booking for a non-bookable doctor is rejected by the booking transaction itself (§5.2). Future-dated offboarding is deliberately not in MVP.
- Verified doctors appear publicly.
- Doctors belong to clinics.
- Clinic can configure schedules.
- Staff or admin creates slot windows per doctor (time range + maxPatients) — and can set a whole week in one bulk request (§11).
- Booking horizon is enforced.
- Patients can book appointments.
- Capacity is enforced.
- Same-slot duplicate is prevented at the DB level, and the per-patient active-booking cap is enforced.
- Concurrent booking is handled safely.
- Online booking uses a 10-minute seat hold; late payment after expiry auto-refunds. The hold is a `SeatHold` record, not a pending appointment, and the appointment is created only when payment is verified (§8.6, §13, §17).
- Staff or admin can change slot capacity but only with a mandatory recorded reason.
- Staff or admin can mark unavailability.
- Doctor's read-only today's-queue view works (slot windows, queue order, ARRIVED/NO_SHOW/COMPLETED flags).
- Admin/staff can check patients in and mark COMPLETED / NO_SHOW; NO_SHOW drives the no-refund rule.
- Existing affected appointments can be handled.
- Patient can cancel/reschedule (subject to the 1-hour cancellation cutoff, waived for doctor-unavailability cases).
- A patient reschedules within the same doctor only; a cross-doctor move is staff/admin-only, and any fee difference is settled by payment (higher fee) or an automatic §17 refund (lower fee) — never silently ignored (§14).
- Doctor-unavailability handling: affected patients notified by email and act themselves; no auto-reschedule; unresponsive bookings auto-cancel after the slot (clinic-caused) and the amount is refunded automatically (§17).
- Appointment lifecycle works.
- Appointment history timeline recorded for every state change (booked → … → completed/no-show), viewable role-scoped.
- Razorpay payment works in test mode.
- Payment success is verified server-side (signature + amount) and duplicate events are idempotent.
- Patient cancels → refund classified by the §17 table: in-window and clinic-caused cases refund automatically, contested cases create a request that admin approves/rejects with a reason; every refund is recorded and audited.
- Pay-at-clinic works (desk marks PAID on collection with amount/method/actor; cash/UPI on the books; cancellations follow refund policy).
- Admin/staff can look up a returning patient by phone/email (COMPLETED-based).
- Emails are sent through Resend.
- Reminders work.
- All timestamps stored as UTC; all display in clinic-local time.
- Clinic defaults seeded from one config: booking horizon 60 days, cancel cutoff 1 h, hold 10 min (released at slot start), lead time 0, one reminder time (2 h before slot start), max active bookings per patient 3, access-token TTL 15 min.
- Audit logs work (append-only — no update/delete path).
- Pino logging works.
- Security middleware is configured.
- Critical API tests pass.
- README explains local setup.
- `/health` performs a real DB check; request IDs flow through logs and error responses; `pg_dump` backup/restore commands documented.

---

# 39. Documentation

Initially maintain:

## PLAN.md

This document is the master development specification.

## README.md

Should eventually contain:

- Product overview
- Features
- Tech stack
- Prerequisites
- Environment setup
- Database setup
- Migration commands
- Seed commands
- Development commands
- Testing commands
- Project structure
- Authentication overview
- Local development instructions

Do not create many additional documentation files until there is a real need.

Potential future documentation files:

- ARCHITECTURE.md
- API.md
- DATABASE.md
- DEPLOYMENT.md

These should only be split out when PLAN.md/README.md becomes too large or when the information deserves an independent reference.

---

# 40. OpenCode Operating Rules

OpenCode must treat PLAN.md as the source of truth.

## Rule 1

Do not rewrite the architecture without explicit approval.

## Rule 2

Do not introduce new major dependencies without explaining why they are needed.

## Rule 3

Do not silently replace selected technologies.

For example:

- Prisma → another ORM
- Express → another framework
- Razorpay → another provider
- TanStack Query → Redux
- Zod → another validator

requires explicit approval.

## Rule 4

Do not generate the entire application in one pass.

Implement phase-by-phase.

## Rule 5

Before implementing a phase:

1. Read PLAN.md.
2. Inspect existing code.
3. Identify dependencies.
4. State the intended changes.
5. Implement.
6. Run relevant tests/type checks/lint.
7. Report what changed.

## Rule 6

Do not modify unrelated files.

## Rule 7

Do not delete existing working functionality to make a new feature easier.

## Rule 8

Do not trust client-side authorization.

Every protected action must be validated on the backend.

## Rule 9

Do not expose secrets.

## Rule 10

When encountering an architectural ambiguity that materially affects:

- database design
- security
- authentication
- authorization
- payment flow
- concurrency
- scheduling
- data integrity

stop and ask for a decision rather than silently making a major architectural choice.

Minor implementation details may be chosen autonomously if they remain consistent with the architecture.

---

# 41. Future AWS Architecture

Explicitly deferred.

Once localhost is stable, evaluate an architecture such as:

Frontend
→ S3/CloudFront or suitable hosting

Backend
→ EC2/ECS or another suitable AWS compute option

Database
→ PostgreSQL on RDS

Additional infrastructure as needed:

- Route 53
- HTTPS/TLS
- Reverse proxy/load balancing
- Secrets management
- Logs/monitoring
- CI/CD
- Backups

Do not begin AWS work during the initial localhost implementation unless explicitly requested.

---

# 42. Future Enhancements

Potential future features:

- AI clinic assistant
- TOON-based LLM data serialization experiment
- WhatsApp/SMS notifications
- Prescription management
- Consultation notes
- Medical document upload
- Queue/token management
- Clinic-configurable discount / concession rules
- Automated no-show flagging (background job after a grace period)
- Richer refund-approval rules and fraud-pattern detection (repeated cancel→refund) on top of the MVP's automatic/queue split
- Advanced analytics
- Multiple clinic organizations
- Subscription/billing for clinics
- Advanced reporting
- Docker
- CI/CD
- AWS deployment
- Background job queue
- Redis
- Dedicated worker services

These are NOT MVP requirements unless later approved.

**Deferred out of MVP by explicit decision** (each was specified earlier in this document and removed on purpose — do not build it without approval):

- **Google OAuth / social login** (§6, §6.4) — patients authenticate with email + password
- **Department entity** — doctors carry a free-text `specialization`; a real `Department` table would be additive later (§30)
- **Future-dated (scheduled) doctor offboarding** — suspend/archive happen immediately; the `scheduledAction` / `effectiveAt` fields and the boundary job are deferred (§5.2)
- **Refresh-token family / reuse ("stolen token") detection** — rotation and immediate session revocation remain; a *session listing / management screen* — the place where a user lists and revokes their own devices — is also deferred (§6.3)
- **Provisional patient claim flow** — a desk-created walk-in record needs no login in MVP; claiming it with an email link and setting a password is deferred (§16, §18)
- **Database `GRANT`/`REVOKE`-based audit immutability** — append-only is enforced by convention, absent edit/delete routes and a test in MVP (§5.2, §20)

---

# 43. Important Non-Goals for MVP

Do not add without explicit approval:

- Video consultations
- Full electronic medical record system
- Complex insurance processing
- Pharmacy management
- Hospital management system
- Advanced accounting
- AI diagnosis
- Unnecessary microservices
- Kubernetes
- Redis without a demonstrated requirement
- GraphQL without a demonstrated requirement
- Event-driven microservice architecture
- Excessive frontend state management

The objective is a strong modular monolith, not premature distributed architecture.

---

# 44. Architecture Philosophy

The initial system should be a well-structured modular monolith.

Conceptually:

Frontend
→ REST API
→ Express application
→ Domain/services
→ Prisma
→ PostgreSQL

External integrations:

- Razorpay
- Resend

This architecture is intentionally simpler than microservices while still providing clear module boundaries.

If the product grows, individual components can later be extracted.

---

# 45. Final Technology Decision Summary

| Area | Technology |
|---|---|
| Frontend | React |
| Language | TypeScript |
| Build tool | Vite |
| Routing | React Router |
| Server state | TanStack Query |
| Client state | Context API/local state |
| UI | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form where useful |
| Validation | Zod |
| Backend | Node.js + Express |
| ORM | Prisma |
| Database | PostgreSQL |
| Authentication | JWT + refresh tokens; password reset via email link or email OTP (§6.2) |
| Password hashing | bcrypt |
| Auth methods | Email + password for all roles (§6) |
| Logging | Pino |
| Email | Resend |
| Payment | Razorpay |
| Testing | Vitest + Supertest |
| API style | REST + JSON |
| Authorization | RBAC + ownership checks |
| Audit | PostgreSQL-backed audit logs |
| Deployment | Deferred |
| Docker | Deferred |
| CI/CD | Deferred |
| AI serialization | TOON only as future/experimental use |

---

# 46. Definition of "Production-Level" for This Project

Production-level does NOT mean adding every technology available.

For this project, production-level means:

- Correct business rules
- Strong data integrity
- Secure authentication
- Correct authorization
- Safe concurrency
- Proper validation
- Payment verification
- Reliable notification architecture
- Auditability
- Structured logging
- Automated tests for critical workflows
- Maintainable architecture
- Clear separation of concerns
- Good UX/error handling
- Environment-based configuration
- Upgradeable architecture
- Single-clinic configuration model (centralized Clinic record)

The system should be designed so that AWS deployment later becomes an infrastructure exercise rather than a complete rewrite of the application.

---

# 47. Final Instruction to the Development Agent

Before writing significant code:

1. Read this PLAN.md completely.
2. Inspect the repository and local environment.
3. Identify what already exists.
4. Create or confirm the project structure.
5. Explain the implementation step.
6. Implement only the current phase.
7. Run validation/tests/type checking.
8. Fix issues before moving forward.
9. Keep documentation updated.
10. Never silently alter major architectural decisions.

The goal is not merely to produce a working application.

The goal is to build a system whose architecture, database design, security model, business rules, testing strategy, and deployment path can be understood and defended by the developer in a real engineering interview or client discussion.
