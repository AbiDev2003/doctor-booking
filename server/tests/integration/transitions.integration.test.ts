import request, { type Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { utcToLocalDateTime } from "../../src/lib/time.js";
import { allowedTargets, TRANSITION_MATRIX } from "../../src/lib/transitionGuard.js";
import {
  createClinic,
  createLoginDoctor,
  createLoginPatient,
  createSlot,
  createStaff,
} from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const app = createApp();
const CLINIC_TIMEZONE = "Asia/Kolkata";

async function accessToken(email: string | null, password: string): Promise<string> {
  if (email === null) {
    throw new Error("Login fixture must have an email.");
  }
  const response = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
  if (typeof response.body.accessToken !== "string") {
    throw new Error("Login did not return an access token.");
  }
  return response.body.accessToken;
}

function timeColumn(instant: Date): Date {
  // `utcToLocalDateTime().time` already includes seconds — appending another
  // `":00"` produced an invalid ISO string like `13:35:05:00`.
  return new Date(`1970-01-01T${utcToLocalDateTime(instant, CLINIC_TIMEZONE).time}Z`);
}

function dateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createTimedSlot(
  doctorId: string,
  startOffsetMinutes: number,
  endOffsetMinutes: number,
) {
  const startAt = new Date(Date.now() + startOffsetMinutes * 60_000);
  const endAt = new Date(Date.now() + endOffsetMinutes * 60_000);
  const localStart = utcToLocalDateTime(startAt, CLINIC_TIMEZONE);

  return prisma.slot.create({
    data: {
      doctorId,
      slotDate: new Date(`${localStart.date}T00:00:00.000Z`),
      startTime: timeColumn(startAt),
      endTime: timeColumn(endAt),
      startAt,
      endAt,
      maxPatients: 10,
    },
  });
}

async function createAppointment(input: {
  readonly doctorId: string;
  readonly patientId: string;
  readonly slotId: string;
  readonly status: $Enums.AppointmentStatus;
  readonly doctorUnavailabilityId?: string | undefined;
}) {
  return prisma.appointment.create({
    data: {
      doctorId: input.doctorId,
      patientId: input.patientId,
      slotId: input.slotId,
      status: input.status,
      doctorName: "Integration Doctor",
      feeAmount: 50_000,
      bookingTime: new Date(),
      doctorUnavailabilityId: input.doctorUnavailabilityId ?? null,
    },
  });
}

async function createClinicCausedMarker(doctorId: string, createdById: string) {
  return prisma.doctorUnavailability.create({
    data: {
      doctorId,
      createdById,
      startAt: new Date(Date.now() - 3_600_000),
      endAt: new Date(Date.now() + 3_600_000),
      reason: "Day 37 integration fixture",
    },
  });
}

function transition(token: string, appointmentId: string, verb: string, body: object = {}): Test {
  return request(app)
    .post(`/api/v1/appointments/${appointmentId}/${verb}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

let doctorId = "";
let patientId = "";
let staffUserId = "";
let patientToken = "";
let staffToken = "";

beforeAll(async () => {
  await createClinic();
  await prisma.clinic.updateMany({ data: { cancelCutoffMinutes: 60 } });

  const doctor = await createLoginDoctor();
  const patient = await createLoginPatient();
  const staff = await createStaff();
  doctorId = doctor.user.id;
  patientId = patient.user.id;
  staffUserId = staff.user.id;
  [patientToken, staffToken] = await Promise.all([
    accessToken(patient.user.email, patient.password),
    accessToken(staff.user.email, staff.password),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 37 chunk 2: cancellation cutoffs, transition walls, and the §13 matrix", () => {
  it("applies the patient cutoff, rejects inside it, and waives it for a clinic-caused booking", async () => {
    const beforeCutoffSlot = await createTimedSlot(doctorId, 90, 150);
    const beforeCutoff = await createAppointment({
      doctorId,
      patientId,
      slotId: beforeCutoffSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const allowed = await transition(patientToken, beforeCutoff.id, "cancel").expect(200);
    expect(allowed.body.appointment.status).toBe($Enums.AppointmentStatus.CANCELLED);

    const insideCutoffSlot = await createTimedSlot(doctorId, 50, 110);
    const insideCutoff = await createAppointment({
      doctorId,
      patientId,
      slotId: insideCutoffSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const inside = await transition(patientToken, insideCutoff.id, "cancel").expect(409);
    expect(inside.body.error.code).toBe("CUTOFF_REACHED");

    const startedSlot = await createTimedSlot(doctorId, -5, 55);
    const started = await createAppointment({
      doctorId,
      patientId,
      slotId: startedSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const afterStart = await transition(patientToken, started.id, "cancel").expect(409);
    expect(afterStart.body.error.code).toBe("CUTOFF_REACHED");

    const marker = await createClinicCausedMarker(doctorId, staffUserId);
    const waivedSlot = await createTimedSlot(doctorId, 5, 65);
    const waived = await createAppointment({
      doctorId,
      patientId,
      slotId: waivedSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
      doctorUnavailabilityId: marker.id,
    });
    const waivedResponse = await transition(patientToken, waived.id, "cancel").expect(200);
    expect(waivedResponse.body.appointment.status).toBe($Enums.AppointmentStatus.CANCELLED);
  });

  it("exempts staff from the cutoff but still requires a cancellation reason", async () => {
    const slot = await createTimedSlot(doctorId, 7, 67);
    const appointment = await createAppointment({
      doctorId,
      patientId,
      slotId: slot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });

    const noReason = await transition(staffToken, appointment.id, "cancel").expect(422);
    expect(noReason.body.error.code).toBe("REASON_REQUIRED");

    const allowed = await transition(staffToken, appointment.id, "cancel", { reason: "Day 37" }).expect(200);
    expect(allowed.body.appointment.status).toBe($Enums.AppointmentStatus.CANCELLED);
  });

  it("enforces the ARRIVED and NO_SHOW clock walls with a one-minute margin", async () => {
    const earlyArrivalSlot = await createTimedSlot(doctorId, 30, 90);
    const earlyArrival = await createAppointment({
      doctorId,
      patientId,
      slotId: earlyArrivalSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const notStarted = await transition(staffToken, earlyArrival.id, "arrive").expect(409);
    expect(notStarted.body.error.code).toBe("SLOT_NOT_STARTED");

    const arrivedSlot = await createTimedSlot(doctorId, -1, 59);
    const arrived = await createAppointment({
      doctorId,
      patientId,
      slotId: arrivedSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const arrivedResponse = await transition(staffToken, arrived.id, "arrive").expect(200);
    expect(arrivedResponse.body.appointment.status).toBe($Enums.AppointmentStatus.ARRIVED);

    const earlyNoShowSlot = await createTimedSlot(doctorId, -30, 30);
    const earlyNoShow = await createAppointment({
      doctorId,
      patientId,
      slotId: earlyNoShowSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const notEnded = await transition(staffToken, earlyNoShow.id, "no-show").expect(409);
    expect(notEnded.body.error.code).toBe("SLOT_NOT_ENDED");

    const noShowSlot = await createTimedSlot(doctorId, -60, -1);
    const noShow = await createAppointment({
      doctorId,
      patientId,
      slotId: noShowSlot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });
    const noShowResponse = await transition(staffToken, noShow.id, "no-show").expect(200);
    expect(noShowResponse.body.appointment.status).toBe($Enums.AppointmentStatus.NO_SHOW);
  });

  it("refuses every pair outside the §13 matrix and names the allowed targets", async () => {
    const statuses = Object.values($Enums.AppointmentStatus);
    const targets = [
      { to: $Enums.AppointmentStatus.ARRIVED, verb: "arrive", body: {} },
      { to: $Enums.AppointmentStatus.COMPLETED, verb: "complete", body: {} },
      { to: $Enums.AppointmentStatus.NO_SHOW, verb: "no-show", body: {} },
      { to: $Enums.AppointmentStatus.REJECTED, verb: "reject", body: { reason: "Day 37" } },
      { to: $Enums.AppointmentStatus.CANCELLED, verb: "cancel", body: { reason: "Day 37" } },
    ];

    for (const [fromIndex, from] of statuses.entries()) {
      for (const [targetIndex, target] of targets.entries()) {
        if (TRANSITION_MATRIX.some((row) => row.from === from && row.to === target.to)) {
          continue;
        }

        // The partial unique index keys on (doctor, date, start time). Vary BOTH
        // columns so every one of the ~20 illegal pairs gets its own slot row.
        const slotIndex = fromIndex * targets.length + targetIndex;
        const startHour = 9 + (slotIndex % 8);
        const slot = await createSlot(doctorId, {
          date: dateAfter(31 + Math.floor(slotIndex / 8)),
          startTime: `${String(startHour).padStart(2, "0")}:00`,
          endTime: `${String(startHour + 1).padStart(2, "0")}:00`,
        });
        const appointment = await createAppointment({
          doctorId,
          patientId,
          slotId: slot.id,
          status: from,
        });
        const response = await transition(staffToken, appointment.id, target.verb, target.body).expect(409);

        expect(response.body.error.code).toBe("INVALID_TRANSITION");
        expect(response.body.error.details.allowedFrom).toEqual(allowedTargets(from));
      }
    }
  });

  it("keeps a matrix-legal pair role-gated at the route", async () => {
    const slot = await createTimedSlot(doctorId, 35, 95);
    const appointment = await createAppointment({
      doctorId,
      patientId,
      slotId: slot.id,
      status: $Enums.AppointmentStatus.CONFIRMED,
    });

    const denied = await transition(patientToken, appointment.id, "arrive").expect(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("allows only one winner when two legal transitions race from ARRIVED", async () => {
    const slot = await createTimedSlot(doctorId, -6, 54);
    const appointment = await createAppointment({
      doctorId,
      patientId,
      slotId: slot.id,
      status: $Enums.AppointmentStatus.ARRIVED,
    });

    const [cancel, complete] = await Promise.all([
      transition(staffToken, appointment.id, "cancel", { reason: "Day 37 race" }),
      transition(staffToken, appointment.id, "complete"),
    ]);

    expect([cancel.status, complete.status].sort()).toEqual([200, 409]);
    const loser = cancel.status === 409 ? cancel : complete;
    expect(loser.body.error.code).toBe("INVALID_TRANSITION");

    const final = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { status: true },
    });
    expect([$Enums.AppointmentStatus.CANCELLED, $Enums.AppointmentStatus.COMPLETED]).toContain(final.status);
  });
});
