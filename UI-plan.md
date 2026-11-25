# UI Plan - Landing Page

## Goal

Redesign the public landing page so it feels like a real clinic website (not a wireframe), while keeping the existing blue + white theme and real data.

## Status

- [x] **Step 1: Lock plan & scope** (locked below, pending any tweaks)
- [x] **Step 2: Navbar / Public layout**
- [x] **Step 3: Hero section**
- [x] **Step 4: Featured doctors section**
- [x] **Step 5: CTA / Motto section**
- [x] **Step 6: Footer + responsive polish**

## Locked Scope (Step 1)

### Visual Direction

- **Theme**: Blue + white, clean medical/trust aesthetic.
- **Primary color**: Existing blue token (`#2563eb`) with soft blue/slate surfaces.
- **Style**: Strong typography, generous spacing, rounded cards, subtle borders/shadows, clear visual hierarchy.
- **Tone**: Professional, calm, trustworthy, and friendly (not cold/corporate).
- **Hero visual**: Clean abstract/gradient graphic or simple UI panel (no fake stock photos/claims).

### Content & Copy Direction

- **Navbar**: Clinic name/brand, `Doctors` link, role-aware `Sign in` / account link.
- **Hero headline**: Clear booking-focused value prop (e.g., "Book trusted doctors with confidence").
- **Hero support**: Short copy about verified doctors, transparent fees, simple booking.
- **Hero CTAs**: Primary `Browse doctors`, secondary `Learn more`/section anchor (if used).
- **Trust cues**: Real stats only - doctor count, specialization count; optional booking horizon/currency only when useful and factual.
- **Featured doctors**: 3 real doctors from API; card shows name, specialization, qualification/experience, fee, `View profile`.
- **CTA/Motto**: Short trust message + factual supporting points + closing CTA.
- **Footer**: Brand, quick links, copyright; no invented clinic address/phone/email.

### Scope Boundaries

- **In scope**: Public landing page flow (`PublicLayout`, `Home`, related public styling/components).
- **Out of scope (for now)**: Backend/API changes, auth flow redesign, doctor profile/booking flow redesign, admin/patient/staff dashboards.
- **Data rule**: Use existing public APIs only; handle loading/error/empty states gracefully.
- **Implementation rule**: Build one section at a time, verify after each step, keep changes focused.

## Data Sources (Existing)

- `apiPublicClinic()` - clinic name, timezone, currency, booking horizon, truthful stats (`doctorCount`, `specializationCount`).
- `apiPublicDoctors()` - doctor name, specialization, qualification, experience, consultation fee.
- Existing role-aware auth/session behavior for nav actions.

## Landing Page Sections

1. **Navbar**
   - Brand/clinic name, nav links, primary auth/account action.
   - Sticky on scroll, mobile-friendly, preserves skip-to-content/accessibility.

2. **Hero**
   - Clear headline and supporting copy.
   - Primary CTA (`Browse doctors`) and secondary CTA.
   - Trust cues from real clinic stats.

3. **Doctors List (Featured)**
   - Featured doctors from real API data.
   - Doctor cards: name, specialization, qualification/experience, fee, profile CTA.
   - Loading/error/empty states handled gracefully.

4. **CTA / Motto Section**
   - Short trust message/motto.
   - Supporting points we can stand behind.
   - Strong closing CTA.

5. **Footer**
   - Brand, quick links, minimal clinic/info area, copyright.
   - Clean, simple, responsive.

## Step-by-Step Build Approach

1. **Lock plan & scope** - Done
   - Sections, tone, visual direction, and boundaries locked in this file.

2. **Navbar / Public layout**
   - Update `PublicLayout` navigation structure and styling.
   - Ensure role-aware account link and mobile behavior work.

3. **Hero section**
   - Build hero layout, copy, CTAs, and real stat/trust cues.
   - Make it responsive and visually polished.

4. **Featured doctors section**
   - Render featured doctors from `apiPublicDoctors`.
   - Style doctor cards and connect to doctor profile routes.

5. **CTA / Motto section**
   - Add trust/motto block with clear closing action.
   - Keep claims factual and aligned with product behavior.

6. **Footer + responsive polish**
   - Implement footer and final spacing/typography pass.
   - Verify mobile/tablet/desktop layout, accessibility, and visual consistency.

## Notes

- Build one section at a time; verify after each step.
- Reuse existing routes/data hooks; avoid unnecessary backend changes.
- Replace legacy public-page styling gradually where appropriate.
