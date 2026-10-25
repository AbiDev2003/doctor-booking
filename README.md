# Doctor Booking

Clinic appointment booking system. React + TypeScript client, Express + TypeScript server, PostgreSQL + Prisma.

## Run locally

Two terminals from the repo root:

```bash
npm run dev:server   # http://localhost:3000
npm run dev:client   # http://localhost:5173
```

Check the server is alive: `http://localhost:3000/api/v1/health`

## Setup

`npm install` in `client/` and `server/`.

Copy `server/.env.example` to `server/.env` and fill it in. The server validates its
environment with Zod at startup and exits with a list of every problem it found, so a
missing or malformed variable fails immediately instead of surfacing later as a null
dereference. `server/.env` is gitignored; only `.env.example` is committed.

## Database

The `postgresql://doctor_booking:...` URL in `server/.env` points at a role and
database that do not exist on a fresh machine. Create them once with:

```bash
npm run db:bootstrap
```

This reads the password out of the `DATABASE_URL` you already set, so the secret is
never written into a script and never lands in your shell history. It connects as the
`postgres` superuser and prompts for *that* password, which is a different secret the
script never touches. The underlying SQL lives in `server/prisma/bootstrap.local.sql`,
which is gitignored and psql-only.

It is idempotent — re-running is safe, and it doubles as the repair step if you ever
drop the database.

To look at the data, `npm run db:studio` opens Prisma Studio in a browser. It works from
the repo root and from `server/`. To apply schema changes to the database,
`npm run db:migrate`.

The database starts out nearly empty — Day 3 only creates a throwaway `Placeholder`
table. The real tables arrive with the Day 4 schema.

## Appointment lifecycle

An appointment is born `CONFIRMED` and moves through a small, explicit state
machine. Every interactive change goes through `appointmentTransition.service.ts`,
which checks the transition matrix, actor role, the clock, the cancellation cutoff
and any open receivable before writing history and audit rows.

```mermaid
stateDiagram-v2
    [*] --> CONFIRMED : book (pay at clinic or verified online payment)

    CONFIRMED --> ARRIVED : staff check-in (from slot start)
    CONFIRMED --> CANCELLED : patient before cutoff / staff
    CONFIRMED --> REJECTED : staff (reason required)
    CONFIRMED --> NO_SHOW : staff (after slot end)

    ARRIVED --> COMPLETED : staff closes visit
    ARRIVED --> CANCELLED : staff (reason required)

    COMPLETED --> [*]
    NO_SHOW --> [*]
    CANCELLED --> [*]
    REJECTED --> [*]
```

- `ARRIVED` opens at the slot's start; `NO_SHOW` is allowed only after its end.
- Patients may cancel only before the cutoff. The cutoff is waived for a
  clinic-caused appointment; staff are not bound by it.
- A visit cannot be closed while a pay-at-clinic payment is still `PENDING`.
- Rescheduling is not a status change: the appointment stays `CONFIRMED` and moves
  to the new slot.
- The doctor-unavailability sweep is the one system-only path into `CANCELLED`;
  it bypasses the interactive matrix and records `actorName = "system"`.

## Doctor unavailability cascade

Marking a doctor unavailable does not delete slots. It writes one
`DoctorUnavailability` row; the availability read model hides overlapping slots,
and existing `CONFIRMED` appointments in that window are flagged for a
clinic-caused cancellation.

```mermaid
flowchart TD
    MARK["Doctor marked unavailable"] --> TX["Single transaction"]
    TX --> ROW["Insert DoctorUnavailability row"]
    ROW --> HIDE["Overlapping slots disappear<br/>from availability reads"]
    ROW --> IMPACT{"CONFIRMED appointments<br/>overlap the window?"}
    IMPACT -->|"no"| COMMIT["Commit"]
    IMPACT -->|"yes"| FLAG["Flag appointment as clinic-caused<br/>store doctorUnavailabilityId"]
    FLAG --> NOTIFY["Queue DOCTOR_UNAVAILABLE notification"]
    NOTIFY --> COMMIT
    COMMIT --> SWEEP["After the slot ends:<br/>auto-cancel sweep"]
    SWEEP --> STILL{"Still CONFIRMED?"}
    STILL -->|"no"| LEAVE["Leave arrived / completed /<br/>already-cancelled rows alone"]
    STILL -->|"yes"| CANCEL["Cancel as system<br/>reason: doctor unavailable"]
    CANCEL --> NOTICE["Queue auto-cancel notification"]
    NOTICE --> MONEY{"Payment state"}
    MONEY -->|"unpaid"| VOID["Void receivable"]
    MONEY -->|"paid"| REFUND["Queue clinic-caused refund"]
    VOID --> FINISH["Free the seat<br/>history + audit"]
    REFUND --> FINISH
```

- The cascade flags appointments; it does not cancel them immediately. The
  auto-cancel runs once the slot has ended, and only for rows still `CONFIRMED`.
- `doctorUnavailabilityId` is the durable "clinic caused this" marker. It waives
  the patient cancellation cutoff and selects the `CLINIC_CAUSED` refund policy.
  When disruptions overlap, the first marker wins.
- A window that any appointment references cannot be deleted; removing an unused
  window simply reopens its slots.
- The sweep body is implemented today. Interval scheduling lands with the Phase 7
  jobs.

## Auth and sessions

Access is a short-lived JWT (15 minutes by default) held in memory. Renewal uses an
opaque refresh token in an `httpOnly` cookie, stored server-side only as a SHA-256
hash for seven days. Refresh tokens rotate on every use; the old token is revoked
in the same transaction.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant D as PostgreSQL

    Note over B,A: Register
    B->>A: POST /auth/register
    A->>D: user (email unverified) + verification token
    A-->>B: 201 generic success
    B->>A: GET /auth/verify-email?token=…
    A->>D: consume token, set emailVerifiedAt
    A-->>B: verified

    Note over B,A: Invited staff / doctor
    B->>A: POST /auth/claim-account
    A->>D: set password, consume claim token
    A-->>B: claimed — sign in next

    Note over B,A: Sign in
    B->>A: POST /auth/login
    A->>D: check attempt limit + password
    A->>D: store hashed refresh token
    A-->>B: access JWT (15m) + refresh cookie (7d)

    Note over B,A: Authenticated request
    B->>A: Authorization: Bearer access
    A->>D: re-read role, deactivation and doctor status
    A-->>B: response

    opt access token expired
        B->>A: POST /auth/refresh (cookie)
        A->>D: revoke old refresh, create new
        A-->>B: new access + rotated cookie
        B->>A: replay the original request
    end

    Note over B,A: Sign out
    B->>A: POST /auth/logout
    A->>D: revoke refresh token
    A-->>B: clear cookie

    Note over B,A: Recovery and revocation
    B->>A: POST /auth/forgot-password
    A-->>B: generic response
    B->>A: POST /auth/reset-password
    A->>D: consume token, set password hash, revoke all sessions
    A-->>B: reset complete — sign in again
```

- Login returns one error for an unknown email and a wrong password, and applies
  database-backed attempt limits before the password comparison.
- Email verification gates booking, not login. An unverified patient can still
  sign in and reach the verification flow.
- Password reset revokes every refresh token. Deactivation, suspension and
  archiving do the same. `requireAuth` also re-reads status and role on every
  request, so an access token already held by the client stops working
  immediately rather than at its 15-minute expiry.
- Claiming an invitation sets the first password and marks the email verified. It
  does not create a session; the user signs in normally afterward.
- Development builds log verification, invitation and reset links to the server
  log. Transactional email is a Phase 7 job.

## Payments

Days 23–26 cover both money paths, and the payment phase is complete on the server:

- **Pay online** — Razorpay hosted checkout. A short `SeatHold` reserves the seat
  before any money moves; a valid signature converts the hold into exactly one
  `CONFIRMED` appointment.
- **Pay at clinic** — booking creates a `PENDING` `Payment` receivable. The desk
  records cash/card/UPI later, or voids it if nothing is owed.
- **Refunds** — online money goes back through Razorpay; offline money is handed
  back as cash or UPI from the desk queue.

Both paths use the same `Payment` and `Refund` rows, and every money movement writes
an audit row. Online payments need `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
`RAZORPAY_WEBHOOK_SECRET`; without them those routes answer `503` and pay-at-clinic
still works.

### At a glance

```mermaid
flowchart LR
    START([Patient picks a slot]) --> CHOICE{"Pay online or at clinic?"}

    CHOICE -->|"Pay online"| HOLD["Reserve seat<br/>create Razorpay order"]
    HOLD --> CHECKOUT["Razorpay checkout"]
    CHECKOUT --> VERIFY["Verify payment<br/>verify route or webhook"]
    VERIFY --> ONLINE_PAID["Appointment CONFIRMED<br/>Payment PAID"]

    CHOICE -->|"Pay at clinic"| BOOK["Appointment CONFIRMED<br/>PENDING receivable"]
    BOOK --> DESK["Desk collects<br/>CASH / CARD / UPI"]
    DESK --> OFFLINE_PAID["Payment PAID"]

    ONLINE_PAID --> REFUND{"Money owed back?<br/>cancel, reject, cheaper<br/>reschedule or clinic-cancel"}
    OFFLINE_PAID --> REFUND
    REFUND --> REFUND_KIND{"Where did the money come from?"}
    REFUND_KIND -->|"Online"| GATEWAY["Razorpay refund"]
    REFUND_KIND -->|"Offline"| HANDBACK["Cash / UPI hand-back<br/>at the desk"]
```

An unpaid pay-at-clinic booking is simply voided when it is cancelled — no refund is
created.

### Detailed flow

```mermaid
flowchart TD
    PATIENT(["Patient picks a slot"]) --> CHOICE{"Pay online or at clinic?"}

    subgraph CLINIC["Pay at clinic — desk"]
        BOOK["POST /appointments<br/>Appointment CONFIRMED<br/>PENDING Payment receivable"]
        COLLECT["POST /payments/offline/collect<br/>CASH / CARD / UPI<br/>collect up to outstanding fee"]
        PAID_OFFLINE["Payment PAID<br/>method, collector, paidAt<br/>notification + audit"]
        VOID["POST /payments/offline/void<br/>Payment VOIDED + audit"]
        BOOK --> COLLECT --> PAID_OFFLINE
        BOOK --> VOID
    end

    subgraph ONLINE["Pay online — Razorpay"]
        ORDER["POST /payments/orders<br/>SeatHold + PENDING Payment<br/>seat reserved before money"]
        CHECKOUT["Razorpay hosted checkout"]
        EDGE{"POST /payments/verify<br/>or order.paid webhook<br/>signature valid?"}
        CONVERT["Conversion transaction<br/>lock payment by order_id"]
        PAID_ONLINE["Appointment CONFIRMED<br/>Payment PAID + gateway id"]
        LATE["Payment PAID<br/>hold released<br/>full refund queued"]
        ORDER --> CHECKOUT --> EDGE
        CHECKOUT -->|"dismissed"| DISMISSED["No payment captured<br/>nothing booked"]
        EDGE -->|"no"| REFUSED["Refused — nothing booked"]
        EDGE -->|"yes"| CONVERT
        CONVERT -->|"live hold + valid slot<br/>held seat becomes booked"| PAID_ONLINE
        CONVERT -->|"refusal after capture"| LATE
        CONVERT -->|"replay — already PAID"| PAID_ONLINE
        ORDER -->|"gateway order fails"| ORDER_FAILED["Payment FAILED<br/>hold released"]
    end

    subgraph LIFECYCLE["After a booking exists"]
        RESCHED["POST /appointments/:id/reschedule<br/>unpaid: PENDING follows new fee<br/>paid cheaper: refund delta<br/>paid dearer: refused"]
        CANCEL["Cancel / reject"]
        AUTO["Doctor-unavailable auto-cancel"]
    end

    subgraph REFUNDS["Refunds"]
        QUEUE["Refund PENDING<br/>policy kind preserved"]
        KIND{"Payment has a<br/>gateway payment id?"}
        WORKER["Refund worker<br/>Razorpay refund"]
        FAILED["Refund FAILED<br/>no automatic retry"]
        RETRY["ADMIN POST /payments/refunds/:id/retry"]
        DESKQ["GET /payments/refunds/desk-hand-backs<br/>staff work list"]
        HAND["POST /payments/refunds/:id/hand-back<br/>CASH or UPI, exact queued amount"]
        DONE["Refund SUCCESS<br/>notification + audit"]
        QUEUE --> KIND
        KIND -->|"yes — online"| WORKER
        WORKER -->|"success"| DONE
        WORKER -->|"error"| FAILED
        FAILED --> RETRY --> WORKER
        KIND -->|"no — offline"| DESKQ --> HAND --> DONE
    end

    CHOICE -->|"Book — pay at clinic"| BOOK
    CHOICE -->|"Pay online"| ORDER

    BOOK --> CANCEL
    BOOK --> AUTO
    PAID_ONLINE -->|"cancel / reject / clinic-caused"| CANCEL
    PAID_ONLINE -->|"clinic-caused"| AUTO
    PAID_OFFLINE -->|"cancel / reject"| CANCEL
    PAID_OFFLINE -->|"clinic-caused"| AUTO

    BOOK -->|"unpaid"| RESCHED
    PAID_ONLINE -->|"paid"| RESCHED
    PAID_OFFLINE -->|"paid"| RESCHED
    RESCHED -->|"paid, cheaper move"| QUEUE

    CANCEL -->|"unpaid"| VOID
    AUTO -->|"unpaid"| VOID
    CANCEL -->|"paid"| QUEUE
    AUTO -->|"paid"| QUEUE
    LATE --> QUEUE
```

Key rules:

- A `PENDING` payment is a receivable, not income. Cancelling, rejecting or
  auto-cancelling an unpaid booking voids it; only a `PAID` payment can create a
  refund.
- The desk never calls a gateway. Collection and cancellation lock the appointment
  row, so either collection wins (later cancellation queues a hand-back) or
  cancellation wins (collection refuses).
- Offline refunds keep their policy kind (`CANCELLATION`, `RESCHEDULE_DELTA`,
  `CLINIC_CAUSED`, …). "Offline" is identified by `Payment.paymentId IS NULL`, not
  by a special refund kind.
- A hand-back pays the exact queued refund amount; there is no partial payout. An
  admin retry exists only for a `FAILED` online refund.
- Offline reschedules use the actual collected amount (minus refunds already owed),
  not the booking-time fee snapshot. A `COMPLETED`/`NO_SHOW` transition is refused
  while a receivable is still `PENDING`.

Code map: `paymentOrder.service.ts` (hold + order), `paymentConvert.service.ts`
(verify/webhook conversion), `offlinePayment.service.ts` (desk collect/void) and
`refund.service.ts` (worker, hand-backs, retry) under `server/src/services/`.

## Checks

Run both before every commit:

```bash
npm run lint
npm run typecheck
```


## Docs

- `plan.md` — full specification
- `code-plan.md` — day-by-day build order
- `loopholes.md` — known gaps in the spec
