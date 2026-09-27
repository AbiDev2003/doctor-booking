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
