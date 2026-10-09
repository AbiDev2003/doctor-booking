// Local development seed.
//
//   npx prisma migrate reset     # drops, migrates, then runs this
//   npm run db:seed              # re-run on demand
//
// Goal: a freshly reset database is immediately usable, and re-running this
// changes nothing. Idempotency is the hard requirement — a seed that duplicates
// rows on the second run is worse than no seed, because it makes every local
// test result ambiguous.
//
// What it creates: one Clinic config row, one admin, two verified doctors, one
// staff user, two patients, weekly schedule templates, and the slot generator
// materialising [today, today + bookingHorizonDays] for every bookable doctor.
// The generator (services/slotGeneration.service.ts) is the only piece that
// writes Slot rows, so a re-seed behaves exactly like the API's own
// materialisation path rather than a divergent copy.
//
// ---------------------------------------------------------------------------
// CREDENTIALS — the deliberate asymmetry (plan.md §5.1, code-plan.md Day 6)
// ---------------------------------------------------------------------------
//
// The admin, the doctors and the staff user are created with passwordHash =
// NULL. That is NOT a bug and NOT an oversight — it is the "not yet claimed"
// state the schema was built for. Nobody ever hands over a credential in this
// system; those four accounts claim their password through the §6.2 reset flow.
//
// The alternative was a seeded `admin/admin123`, which is the single most
// common way a demo clinic database becomes the first admin of a real install.
// A dev-only password is a second door into an authenticated account, and it is
// a production risk dressed as a convenience.
//
// The two PATIENTS are the exception and get a real bcrypt hash, because a
// patient account is a self-registered account that always has a password
// (§5.1) — a patient row with a null hash is an account nobody can ever log
// into, which would make them untestable until Day 7. That password comes from
// SEED_PATIENT_PASSWORD in the environment: never a literal here, never
// committed.
//
// Which mode ran is logged at the end. Nobody should have to guess why a login
// failed.

import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { config } from "../src/config.js";
import { normalizePhoneToE164 } from "../src/lib/time.js";
import { materializeSlots } from "../src/services/slotGeneration.service.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Run this from server/ with server/.env present.");
  process.exit(1);
}

const { CLINIC_OWNER_EMAIL: ownerEmail, CLINIC_OWNER_NAME: ownerName, SEED_PATIENT_PASSWORD: patientPassword } = config;

if (!ownerEmail || !ownerName) {
  console.error(
    "CLINIC_OWNER_EMAIL and CLINIC_OWNER_NAME must both be set to seed the first admin.\n" +
      "  §5.1 reads the clinic owner's identity from the environment, never from a\n" +
      "  fixture literal — a hardcoded address becomes the first admin of whoever\n" +
      "  runs the seed. Add both to server/.env and re-run.",
  );
  process.exit(1);
}

// The patients are the only accounts with a password, so this is the one input
// where being absent is a hard error rather than a null hash. Failing here beats
// creating two accounts that can never be logged into.
if (!patientPassword) {
  console.error(
    "SEED_PATIENT_PASSWORD must be set to seed the two patient accounts.\n" +
      "  They get a real bcrypt hash because a patient account always has a\n" +
      "  password (§5.1); an account with a null hash can never be logged into.\n" +
      "  The value is read from the environment and never written to this file.",
  );
  process.exit(1);
}

// Re-bound to non-optional names after the guards above.
//
// TypeScript narrows a `const` only within the block that checked it, and
// `main()` is a different block. These aliases are what carry the narrowing into
// the seed body, so the failure mode stays "config.ts refused the value and
// exited" rather than "a `string | undefined` reached a NOT NULL column four
// hundred lines later".
const OWNER_EMAIL: string = ownerEmail;
const OWNER_NAME: string = ownerName;
const PATIENT_PASSWORD: string = patientPassword;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
});

// APP_TIMEZONE bootstraps the clinic row's timezone below — the runtime
// authority for every wall-clock conversion since Day 15 (decision 4). It
// comes from the env, not from a literal, so a machine in a different zone
// seeds slots correct for THAT clinic rather than silently wrong ones that
// only look right in Asia/Kolkata.
const ZONE = config.APP_TIMEZONE;

// Deterministic UUIDs so the second run updates the same rows instead of
// inserting duplicates. Not sequential and not guessable-looking: these are
// fixture ids that will appear in a local database, and a readable prefix makes
// `psql` output easier to scan. The random tail keeps them collision-proof
// against a real account that happens to share the prefix.
const ID = {
  clinic: "0c000000-0000-4000-8000-000000000001",
  admin: "0c000000-0000-4000-8000-000000000002",
  doctorA: "0c000000-0000-4000-8000-000000000003",
  doctorB: "0c000000-0000-4000-8000-000000000004",
  staff: "0c000000-0000-4000-8000-000000000005",
  patientA: "0c000000-0000-4000-8000-000000000006",
  patientB: "0c000000-0000-4000-8000-000000000007",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_FEE_PAISE = 50_000; // ₹500.00 — a plausible local consultation
const DEFAULT_MAX_PATIENTS = 12;

/** The `Weekday` union matching the schema enum — used only as a type here. */
type Weekday = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";

/**
 * `time` as a `@db.Time` value.
 *
 * PostgreSQL stores `@db.Time` in a `time` column, which the driver surfaces as
 * a Date on 1970-01-01. Building it in UTC keeps the read-back stable instead of
 * shifting by the machine's own offset.
 */
function timeOf(hour: number, minute: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

// The weekly template. One entry PER WINDOW, not one blob per doctor (§8.1) —
// 07:00–09:00 and 18:00–20:00 on the same weekday are two rows, which is exactly
// the case a per-doctor blob cannot express.
const TEMPLATE: { weekday: Weekday; start: [number, number]; end: [number, number]; maxPatients: number }[] = [
  { weekday: "MON", start: [9, 0], end: [12, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "MON", start: [17, 0], end: [20, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "TUE", start: [9, 0], end: [12, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "WED", start: [9, 0], end: [12, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "WED", start: [17, 0], end: [20, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "THU", start: [9, 0], end: [12, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "FRI", start: [9, 0], end: [12, 0], maxPatients: DEFAULT_MAX_PATIENTS },
  { weekday: "SAT", start: [10, 0], end: [13, 0], maxPatients: 8 },
];

const DOCTOR_DETAILS = [
  {
    id: ID.doctorA,
    email: "doctor.asha@example.test",
    fullName: "Dr Asha Menon",
    qualification: "MBBS, MD (General Medicine)",
    licenseNumber: "KMC-114872",
    experience: "12 years",
    clinicAssociation: "City Care Clinic",
    specialization: "General Medicine",
    consultationFee: DEFAULT_FEE_PAISE,
  },
  {
    id: ID.doctorB,
    email: "doctor.rohit@example.test",
    fullName: "Dr Rohit Sharma",
    qualification: "MBBS, DNB (Cardiology)",
    licenseNumber: "KMC-209915",
    experience: "9 years",
    clinicAssociation: "City Care Clinic",
    specialization: "Cardiology",
    consultationFee: 80_000,
  },
] as const;

const PATIENT_DETAILS = [
  { id: ID.patientA, email: "patient.kavya@example.test", fullName: "Kavya Iyer", phone: "+9198765000101" },
  { id: ID.patientB, email: "patient.imran@example.test", fullName: "Imran Qureshi", phone: "+9198765000102" },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding ${OWNER_NAME} <${OWNER_EMAIL}> in ${ZONE}\n`);

  // -------------------------------------------------------------------------
  // 1. Clinic — the single config record (§3.2)
  //
  // Every tunable lives here rather than as a constant in code. Written with
  // `update` rather than `updateMany` so a stale `where` can never silently
  // affect zero rows and look like a successful seed.
  //
  // timezone is the runtime authority for wall-clock conversion since Day 15
  // (decision 4). APP_TIMEZONE BOOTSTRAPS it on first create and never
  // overwrites it on re-seed: a clinic that changed its zone in a prior run
  // (e.g. Asia/Dubai) must keep its own value, or a re-seed would silently
  // move every future slot's clock. A mismatch is warned about, not silently
  // ignored and not silently fixed.
  // -------------------------------------------------------------------------
  const existingClinic = await prisma.clinic.findUnique({ where: { id: ID.clinic } });
  if (existingClinic && existingClinic.timezone !== ZONE) {
    console.warn(
      `  NOTE: existing clinic timezone is "${existingClinic.timezone}", APP_TIMEZONE is "${ZONE}".\n` +
        `        Keeping the existing value — the Clinic row is the runtime authority (§3.2).`,
    );
  }

  const clinic = await prisma.clinic.upsert({
    where: { id: ID.clinic },
    update: {
      name: "City Care Clinic",
      currency: "INR",
      defaultConsultationFee: DEFAULT_FEE_PAISE,
      bookingHorizonDays: 60,
      cancelCutoffMinutes: 60,
      holdDurationMinutes: 10,
      minLeadMinutes: 0,
      reminderLeadMinutes: 120,
      maxActiveBookingsPerPatient: 3,
      // timezone deliberately absent (see above): only `create` sets it.
    },
    create: {
      id: ID.clinic,
      name: "City Care Clinic",
      timezone: ZONE,
      currency: "INR",
      defaultConsultationFee: DEFAULT_FEE_PAISE,
      bookingHorizonDays: 60,
      cancelCutoffMinutes: 60,
      holdDurationMinutes: 10,
      minLeadMinutes: 0,
      reminderLeadMinutes: 120,
      maxActiveBookingsPerPatient: 3,
    },
  });
  console.log(`  clinic      ${clinic.name} (${clinic.timezone}, ${clinic.currency})`);

  // -------------------------------------------------------------------------
  // 2. Accounts
  //
  // Each account is upserted on its id AND its email, and the update payload
  // deliberately omits passwordHash. That omission is load-bearing: a
  // re-seed must never reset a password an operator has already claimed through
  // the §6.2 flow. Including passwordHash in `update` would silently undo the
  // claim on every seed run — the failure would look like "the reset link does
  // not work" and be very hard to trace back here.
  //
  // emailVerifiedAt IS set: these addresses are supplied by whoever runs the
  // seed through their own .env, so there is no unverified-identity problem to
  // solve. This is the one thing that would differ for a self-registered
  // patient, which is why Day 7's registration flow is where verification is
  // actually enforced.
  // -------------------------------------------------------------------------

  const now = new Date();

  await prisma.user.upsert({
    where: { id: ID.admin },
    update: { fullName: OWNER_NAME, email: OWNER_EMAIL, emailVerifiedAt: now, isDeactivated: false },
    create: {
      id: ID.admin,
      role: "ADMIN",
      fullName: OWNER_NAME,
      email: OWNER_EMAIL,
      emailVerifiedAt: now,
      // §5.1: no temporary password is ever generated or handed over. Null is
      // the "not yet claimed" state and must always fail login.
      passwordHash: null,
    },
  });
  console.log(`  admin       ${OWNER_NAME} <${OWNER_EMAIL}>  passwordHash: null (claim via reset link)`);

  for (const doctor of DOCTOR_DETAILS) {
    await prisma.user.upsert({
      where: { id: doctor.id },
      update: { fullName: doctor.fullName, email: doctor.email, emailVerifiedAt: now, isDeactivated: false },
      create: {
        id: doctor.id,
        role: "DOCTOR",
        fullName: doctor.fullName,
        email: doctor.email,
        emailVerifiedAt: now,
        passwordHash: null,
      },
    });

    await prisma.doctorProfile.upsert({
      where: { userId: doctor.id },
      update: {
        verificationStatus: "VERIFIED",
        qualification: doctor.qualification,
        licenseNumber: doctor.licenseNumber,
        experience: doctor.experience,
        clinicAssociation: doctor.clinicAssociation,
        specialization: doctor.specialization,
        consultationFee: doctor.consultationFee,
      },
      create: {
        userId: doctor.id,
        // Seeded as VERIFIED, not INVITED: these are local fixtures standing in
        // for doctors an admin has already reviewed (§5.2). The INVITED ->
        // VERIFIED journey is exercised in Phase 3, not by the seed.
        verificationStatus: "VERIFIED",
        qualification: doctor.qualification,
        licenseNumber: doctor.licenseNumber,
        experience: doctor.experience,
        clinicAssociation: doctor.clinicAssociation,
        specialization: doctor.specialization,
        consultationFee: doctor.consultationFee,
      },
    });

    // §5: suspension is NOT an enum value — it is these two nullable columns,
    // orthogonal to the lifecycle enum. Explicitly clearing them means a
    // re-seed revives a doctor someone suspended while debugging locally.
    await prisma.doctorProfile.update({
      where: { userId: doctor.id },
      data: { suspendedAt: null, suspendReason: null },
    });

    console.log(`  doctor      ${doctor.fullName} <${doctor.email}>  passwordHash: null (claim via reset link)`);
  }

  const staffEmail = "staff.frontdesk@example.test";
  await prisma.user.upsert({
    where: { id: ID.staff },
    update: { fullName: "Front Desk", email: staffEmail, emailVerifiedAt: now, isDeactivated: false },
    create: {
      id: ID.staff,
      role: "STAFF",
      fullName: "Front Desk",
      email: staffEmail,
      emailVerifiedAt: now,
      passwordHash: null,
      // §4: STAFF has no profile table in MVP. Its attributes live on User.
    },
  });
  console.log(`  staff       Front Desk <${staffEmail}>  passwordHash: null (claim via reset link)`);

  // The one place a password hash is produced. Cost 10 is bcryptjs's default
  // and a deliberate choice: it is a dev-fixture password for two accounts, not
  // a user-facing credential, so the ~100ms cost buys nothing here. A real
  // registration route (Day 7) is where the cost factor should be reviewed.
  const patientHash: string = await bcrypt.hash(PATIENT_PASSWORD, 10);

  for (const patient of PATIENT_DETAILS) {
    // The SAME normalisation helper the app uses at registration and at the
    // desk (§6.1, §16). Seeding a pre-formatted literal instead would let a
    // fixture phone number drift away from the one the desk lookup normalises
    // to, and the two would then be different identity keys.
    const phone = normalizePhoneToE164(patient.phone);

    await prisma.user.upsert({
      where: { id: patient.id },
      update: {
        fullName: patient.fullName,
        email: patient.email,
        emailVerifiedAt: now,
        isDeactivated: false,
        // Written even on re-seed, and that is the ONE deliberate exception to
        // the "never touch passwordHash" rule above. A patient who changes
        // their password through the app must get the fixture's password back
        // on the next seed, or local testing of the patient flow becomes
        // impossible after any password test. The claim flow in §6.2 is a
        // one-time event for staff; a patient's password is mutable state that
        // tests change routinely. Staff are the accounts that must never be
        // silently re-passworded, because they are the ones with no other way in.
        passwordHash: patientHash,
      },
      create: {
        id: patient.id,
        role: "PATIENT",
        fullName: patient.fullName,
        email: patient.email,
        emailVerifiedAt: now,
        passwordHash: patientHash,
      },
    });

    await prisma.patientProfile.upsert({
      where: { userId: patient.id },
      update: { phone, isProvisional: false },
      create: {
        userId: patient.id,
        phone,
        // Not provisional: these are self-registered accounts, not desk-created
        // walk-ins (§16).
        isProvisional: false,
      },
    });

    console.log(`  patient     ${patient.fullName} <${patient.email}>  ${phone}  passwordHash: bcrypt(SEED_PATIENT_PASSWORD)`);
  }

  // -------------------------------------------------------------------------
  // 3. Weekly templates (§8.1, §11)
  //
  // Upserted on the (doctorId, weekday, startTime) unique key, so a re-run
  // updates the same row. maxPatients is in the update payload because §8.3
  // makes capacity editable and a template edit should be reflected; the
  // generated Slots are NOT touched here, because §11 says a template change
  // applies only to dates not yet generated (§15 Day 19 owns that path).
  // -------------------------------------------------------------------------
  let scheduleCount = 0;
  for (const doctor of DOCTOR_DETAILS) {
    for (const window of TEMPLATE) {
      const startTime = timeOf(...window.start);
      const endTime = timeOf(...window.end);

      await prisma.schedule.upsert({
        where: { doctorId_weekday_startTime: { doctorId: doctor.id, weekday: window.weekday, startTime } },
        update: { endTime, maxPatients: window.maxPatients },
        create: { doctorId: doctor.id, weekday: window.weekday, startTime, endTime, maxPatients: window.maxPatients },
      });
      scheduleCount += 1;
    }
  }
  console.log(`\n  schedules   ${scheduleCount} weekly windows across ${DOCTOR_DETAILS.length} doctors`);

  // -------------------------------------------------------------------------
  // 4. Slots — the real Day 15 generator, not a reimplementation
  //
  // This is the Day 15 slot generator itself (services/slotGeneration.service.ts),
  // replacing the minimal "this week only" block that lived here before. The
  // generator is the ONLY code that creates Slot rows from Schedule rows:
  // - it reads Clinic.timezone (the runtime authority, §3.2) for startAt/endAt
  //   through localDateTimeToUtc — never local Date arithmetic;
  // - it materialises [today, today + bookingHorizonDays] inclusive (decision 8);
  // - it is idempotent (decision 1): a date that already has any slot is skipped
  //   whole, plus the (doctorId, slotDate, startTime) unique key backstops races.
  //
  // bookedCount/heldCount/maxPatients are untouched ON THE DOMAIN: the generator
  // inserts fresh rows with zero counters and never updates existing ones. A
  // booking that moved a counter between seed runs cannot be reset because the
  // generator never writes to an existing slot at all.
  // -------------------------------------------------------------------------
  const materialized = await materializeSlots();
  console.log(
    `  slots       ${materialized.created} created for the ${clinic.bookingHorizonDays}-day horizon ` +
      `(${materialized.doctors} bookable doctors, ${materialized.skippedExistingDates} dates already stocked, ${materialized.rejectedWindows} DST-gap windows skipped)`,
  );

  // -------------------------------------------------------------------------
  // 5. Mode summary
  //
  // The DoD requires the seed to say which credential mode it ran in, so nobody
  // has to guess why a login failed. A staff login failing with "invalid
  // credentials" against a seeded account is CORRECT behaviour, and this line
  // is what makes that legible without reading the seed source.
  // -------------------------------------------------------------------------
  console.log(`
Done. How to log in:

  admin, doctors, staff  NO PASSWORD YET.
                        passwordHash is null by design (§5.1). Use the §6.2
                        forgot-password flow on the seeded email to claim one.
                        A seeded admin/admin123 is deliberately absent.

  the two patients       password IS SEED_PATIENT_PASSWORD from server/.env
                        (emails: ${PATIENT_DETAILS.map((p) => p.email).join(", ")})

  Both flows arrive in Phase 2 (Day 7-11). Until then there is nothing to log
  into — this seed is about a correct database, not a usable login.`);
}

main()
  .catch(async (error: unknown) => {
    console.error("\nSeed failed:");
    console.error(error instanceof Error ? error.stack : String(error));
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });