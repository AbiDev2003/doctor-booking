# Pending Deployment Tasks / Context Snapshot

This file is temporary and should be deleted after the remaining Render Git auto-deploy setup is verified.

## Current objective

Finish deployment automation:

- Frontend: Vercel — done and Git auto-deploy verified.
- Backend: Render — service is live, but GitHub webhook/Git provider connection still needs a one-time browser setup.
- Database: Neon — done. No Neon Git hook is needed because Render runs migrations on every deploy.

Work is on `main` only. Do not manually redeploy after future code changes; pushes to `main` should deploy automatically.

## Current status update (frontend fetch check)

The user has paused the Render GitHub connection task for now so we can verify why the frontend appears not to fetch data.

Retried/verified on `2026-11-26`:

- `https://city-care-clinic-api.onrender.com/api/v1/health` → `200 {"status":"ok","db":"up"}`
- CORS preflight for `POST /api/v1/auth/login` from `https://city-care-clinic-pearl.vercel.app` → `204`, with:
  - `access-control-allow-origin: https://city-care-clinic-pearl.vercel.app`
  - `access-control-allow-credentials: true`
  - allowed headers include `content-type`
- `GET /api/v1/public/clinic` with Vercel origin → `200`
  - `City Care Clinic`, `Asia/Kolkata`, `INR`, `doctorCount: 3`
- `GET /api/v1/public/doctors` with Vercel origin → `200`
  - returns real doctors including `Dr Asha Menon`, `Dr Rohit Sharma`
- Built Vercel asset `https://city-care-clinic-pearl.vercel.app/assets/index-D44XbIU3.js` contains `https://city-care-clinic-api.onrender.com/api/v1`.
- Render logs show the public API requests succeeding with `200`.
- Refresh cookie config is already split-deployment safe in production:
  - `secure: true`
  - `sameSite: "none"`
  - path `/api/v1/auth`
- `DoctorAvatar` falls back to initials if an image fails, so broken profile photos do not block text data rendering.

Conclusion so far: the public storefront API fetch path is working. If the user sees no data, clarify whether it is:
1. Public home/doctors list,
2. Authenticated dashboard pages,
3. Doctor profile images only, or
4. Local development instead of the live Vercel site.

Known cosmetic issue that can look like broken data: doctor `profileImageUrl` values are still local `/uploads/doctors/...` paths. On Vercel those resolve against the frontend domain, not the Render backend, so images will not load and avatars fall back to initials.

## Render auto-deploy fallback implemented

The user did not complete the browser-only Render GitHub credential step, so a GitHub Actions fallback was added:

- Added `.github/workflows/render-deploy.yml`.
- It triggers on every push to `main` and on manual `workflow_dispatch`.
- It calls Render API:
  - `POST https://api.render.com/v1/services/srv-dc42lu8u01pc73emqong/deploys`
  - body uses the exact `github.sha` as `commitId`.
- Added encrypted repository secret `RENDER_API_KEY` using the available GitHub credential and the Render CLI API key. The secret value is not stored in the repo.
- This gives automatic backend deploys without requiring the Render GitHub OAuth/webhook setup.
- If native Render GitHub auto-deploy is connected later, remove this workflow to avoid duplicate deploys.

---

## Live deployment details

### Frontend — Vercel

- Project: `city-care-clinic`
- Project ID: `prj_uMfgBupaXrQX0qrY3zym0icxcOEU`
- Team/scope: `abinash-dashs-projects-1dd84978`
- Repo connected: `AbiDev2003/doctor-booking`
- Production branch: `main`
- Stable URL: `https://city-care-clinic-pearl.vercel.app`
- Dashboard: `https://vercel.com/abinash-dashs-projects-1dd84978/city-care-clinic`
- Persistent env var:
  - `VITE_API_URL=https://city-care-clinic-api.onrender.com/api/v1`
  - Set for Production, Preview, and Development.
- Vercel build is configured from the repo root via `vercel.json`:
  - Installs server deps for shared schemas: `npm install --prefix server --include=dev && cd client && npm install`
  - Builds client: `cd client && npm run build`
  - Output: `client/dist`
- Git auto-deploy verified with commit `84f3802`; Vercel deployment reached `READY`.
- Built frontend JS contains the Render API URL.

### Backend — Render

- Service: `city-care-clinic-api`
- Service ID: `srv-dc42lu8u01pc73emqong`
- URL: `https://city-care-clinic-api.onrender.com`
- Dashboard: `https://dashboard.render.com/web/srv-dc42lu8u01pc73emqong`
- Service settings page: `https://dashboard.render.com/web/srv-dc42lu8u01pc73emqong/settings`
- Plan: Free
- Region: Singapore
- Root directory: `server`
- Branch field: `main`
- Repo field currently: `https://github.com/AbiDev2003/doctor-booking`
- Build command: `npm install --include=dev && npx prisma generate && npm run build`
- Pre-deploy command: `npx prisma migrate deploy`
- Start command: `npm start`
- Health endpoint: `https://city-care-clinic-api.onrender.com/api/v1/health`
- Health proof: `{"status":"ok","db":"up"}`
- CORS proof: `access-control-allow-origin: https://city-care-clinic-pearl.vercel.app`

Render env vars already set:

- `DATABASE_URL` — Neon pooled URL used by app
- `DATABASE_URL_UNPOOLED` — Neon direct URL used by Prisma migrations
- `NODE_ENV=production`
- `CLIENT_URL=https://city-care-clinic-pearl.vercel.app`
- `APP_TIMEZONE`
- `JWT_ACCESS_SECRET`
- `ACCESS_TOKEN_TTL`
- `RESEND_API_KEY`
- `EMAIL_FROM=noreply@mail.citycareclinic.xyz`
- `EMAIL_FROM_NAME=City Care Clinic`
- Razorpay vars
- Clinic owner vars

Important: do not change the working Resend sender values.

### Database — Neon

- Project name: `citycareclinic-doctorbooking`
- Project ID: `small-truth-55233303`
- Org ID: `org-icy-fog-56283997`
- Branch: `production`
- Branch ID: `br-dry-mountain-bii8gkw1`
- Database: `neondb`
- Role: `neondb_owner`
- Region: Singapore
- Migrations applied: 8
- Data restored from local DB; no seed needed.
- Verified counts after restore:
  - users: `25`
  - doctors: `5`
  - clinics: `1`
  - appointments: `9`
  - doctor profiles: `5`
  - migrations: `8`
- API verified real restored data: `City Care Clinic`, `Dr Asha Menon`, `Dr Rohit Sharma`.

Neon Git hook is not needed. Render pre-deploy runs `npx prisma migrate deploy`, so schema changes deploy with backend code.

---

## Architecture / deployment decisions

- Vercel hosts the Vite frontend.
- Render hosts the Express backend.
- Neon hosts Postgres.
- Hostinger is only for domain/DNS, not backend hosting.
- Custom domain `citycareclinic.xyz` is active for DNS/domain purposes but is **not** attached to Vercel yet.
- If the custom domain is attached later, update Render `CLIENT_URL` and README live URLs.
- No sleep-prevention hacks. Neon scale-to-zero is acceptable; Render free-plan sleep is accepted for now.
- Keep existing `@prisma/adapter-pg` driver; Neon docs confirm it is valid for long-running Express runtime.
- Do not seed. Restored local data is the showcase data.
- No broad data cleanup for showcase; only optional cosmetic cleanup later.

---

## Work already completed

### README/docs

- Expanded `README.md` with:
  - overview
  - tech badges/logos
  - UI screenshots
  - project structure rationale
  - live URLs
- Live URLs currently in README:
  - Client: `https://city-care-clinic-pearl.vercel.app`
  - Server: `https://city-care-clinic-api.onrender.com`

### Deployment/config fixes

- Neon production Postgres wired into app config.
- Root `.env.local` used by shared env loader.
- `server/prisma.config.ts` uses `DATABASE_URL_UNPOOLED` for migrations.
- Vercel root build config added through `vercel.json`.
- Vercel install command installs server deps so `@shared` schemas can resolve `zod`.
- Vercel local config/env files ignored via `.gitignore`, while keeping `.env.example` files trackable.
- `server/.env.example` fixed to preserve `EMAIL_FROM_NAME=City Care Clinic`.

### Commits pushed to `main`

- `fd472b8` — `docs: expand README with overview, stack and screenshots`
- `2b49dc1` — `chore(neon): wire production Postgres and shared env loading`
- `20f0bb4` — `chore(vercel): build client from repo root for shared validation`
- `3e569b8` — `chore(vercel): install server deps for shared schemas`
- `f5803a0` — `chore: ignore Vercel local config without hiding env examples`
- `84f3802` — `docs: add live demo URLs`

---

## Current blocker: Render Git auto-deploy not fully connected

Render shows:

- `autoDeploy: "yes"`
- `autoDeployTrigger: "commit"`
- branch `main`
- repo `https://github.com/AbiDev2003/doctor-booking`

However, push `84f3802` did **not** create a new Render deploy. Vercel reacted to that same push, but Render did not.

Investigation result:

- Render deploy history stayed at previous API-triggered deploy `dep-dc42u27f3r2c73a4tro0`, commit `f5803a0`.
- No newer Render deploy for `84f3802`.
- `GET /build-sources` returned `[]`.
- Attempted `POST /build-sources` with the exact Git/build config returned:
  - `400 build source reuse is not enabled for this workspace`
- Render docs confirm automatic deploys require a connected Git provider; a plain repo URL alone does not create the webhook.
- Render CLI/API token cannot complete GitHub OAuth. This needs a one-time browser action.

Render deploy IDs already seen:

- `dep-dc42lv0u01pc73emqqu0` — first failed build
- `dep-dc42miajnfac73bb5qhg` — fixed live deploy
- `dep-dc42u27f3r2c73a4tro0` — env/CORS update live deploy

---

## Paused pending task: one-time Render GitHub connection

User chose: **Connect in Render (Recommended)**, but later said to pause this task so we can investigate frontend data fetching first. Do not rely on this being done yet. A GitHub Actions fallback now covers auto-deploy; the browser step is only needed if we want native Render Git integration instead.

Do this later in the browser:

1. Open `https://dashboard.render.com/u/settings#account-security`
2. Go to **Account Security → Git Deployment Credentials**
3. Click **Add credential → GitHub**
4. Authorize Render for `AbiDev2003/doctor-booking`
5. If repo does not appear, visit `https://github.com/apps/render/installations/new` and enable repository access for `doctor-booking`
6. Open `https://dashboard.render.com/web/srv-dc42lu8u01pc73emqong/settings`
7. Select/re-save GitHub repo:
   - Repo: `AbiDev2003/doctor-booking`
   - Branch: `main`
   - Root directory: `server`
   - Auto-Deploy: **On Commit**
8. Save settings.

After the user says done:

- Push a harmless empty commit to `main`, e.g. `git commit --allow-empty -m "chore: verify render auto deploy" && git push origin main`
- Confirm Render creates a new deploy automatically with matching commit SHA.
- Check with:
  - `render deploys list srv-dc42lu8u01pc73emqong -o json`
  - Expected newest deploy status should become `live`, trigger should indicate Git/commit rather than API.
- Then delete `pendingtask.md`.

---

## Optional follow-up tasks

These are not blocking the current deployment:

1. Attach custom domain `citycareclinic.xyz` to Vercel if desired.
   - Then update Render `CLIENT_URL`.
   - Then update README live URLs.
2. Cosmetic showcase cleanup:
   - Remove `Staff Invited Doc`.
   - Clear/remote profile image URLs that still point to local `/uploads/doctors/...`; those will not work on Render/Vercel.
   - Delete expired invitations.
3. Rotate the Resend API key later because it appeared in earlier diagnostic output.
4. Confirm Hostinger `.xyz` auto-renew/autopay status or set a renewal reminder.
5. If reminders/scheduler are required later, external cron/VPS is needed; in-process scheduler is unreliable on sleeping hosts.

---

## Local files / notes

- Current branch: `main`
- Latest pushed commit: `84f3802`
- Root `.env.local` is ignored by git. It contains Neon vars plus Vercel-added `VERCEL_OIDC_TOKEN`.
- `server/.env.example` is tracked and documents required env vars.
- Do not commit secrets, tokens, API keys, or local env files.
- This `pendingtask.md` file is temporary and should be deleted after Render auto-deploy is verified.
