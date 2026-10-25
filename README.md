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
