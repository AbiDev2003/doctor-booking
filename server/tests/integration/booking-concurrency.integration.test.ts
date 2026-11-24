import request, { type Test } from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { createClinic, createLoginDoctor, createLoginPatient, createSlot } from "./factories.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

const app = createApp();

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

function book(token: string, slotId: string): Test {
  return request(app)
    .post("/api/v1/appointments")
    .set("Authorization", `Bearer ${token}`)
    .send({ slotId });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 37 chunk 1: booking races and capacity", () => {
  it("hands the last seats to exactly as many winners as there are seats", async () => {
    await createClinic();
    const doctor = await createLoginDoctor();
    const slot = await createSlot(doctor.user.id, { maxPatients: 2 });
    const patients = await Promise.all(Array.from({ length: 5 }, () => createLoginPatient()));
    const tokens = await Promise.all(patients.map((patient) => accessToken(patient.user.email, patient.password)));

    const responses = await Promise.all(tokens.map((token) => book(token, slot.id)));
    const winners = responses.filter((response) => response.status === 201);
    const full = responses.filter(
      (response) => response.status === 409 && response.body.error?.code === "SLOT_FULL",
    );

    expect(winners.length).toBe(2);
    expect(full.length).toBe(3);

    const slotAfter = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(slotAfter.bookedCount).toBe(2);
    expect(slotAfter.heldCount).toBe(0);
    expect(
      await prisma.appointment.count({
        where: { slotId: slot.id, status: $Enums.AppointmentStatus.CONFIRMED },
      }),
    ).toBe(2);

    for (const response of winners) {
      const appointmentId = response.body.appointment.id as string;
      expect(
        await prisma.appointmentHistory.count({
          where: { appointmentId, eventType: $Enums.AppointmentEventType.BOOKED },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { targetType: "appointment", targetId: appointmentId, action: "APPOINTMENT_BOOKED" },
        }),
      ).toBe(1);
    }
    for (const response of full) {
      expect(response.body.appointment).toBeUndefined();
    }
  });

  it("lets only one of several concurrent same-slot attempts by one patient win", async () => {
    await createClinic();
    const doctor = await createLoginDoctor();
    const slot = await createSlot(doctor.user.id, { maxPatients: 5 });
    const patient = await createLoginPatient();
    const token = await accessToken(patient.user.email, patient.password);

    const responses = await Promise.all(Array.from({ length: 4 }, () => book(token, slot.id)));
    expect(responses.filter((response) => response.status === 201).length).toBe(1);
    expect(
      responses.filter((response) => response.status === 409 && response.body.error?.code === "ALREADY_BOOKED")
        .length,
    ).toBe(3);

    expect(await prisma.appointment.count({ where: { patientId: patient.user.id, slotId: slot.id } })).toBe(1);
    const slotAfter = await prisma.slot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(slotAfter.bookedCount).toBe(1);
  });

  it("enforces the per-patient cap, counting a live seat hold as an active seat", async () => {
    await createClinic();
    const doctor = await createLoginDoctor();
    const patient = await createLoginPatient();
    const token = await accessToken(patient.user.email, patient.password);
    const slots = await Promise.all(
      Array.from({ length: 5 }, (_, index) => {
        const start = String(index + 9).padStart(2, "0");
        const end = String(index + 10).padStart(2, "0");
        return createSlot(doctor.user.id, { startTime: `${start}:00`, endTime: `${end}:00` });
      }),
    );

    for (const slot of slots.slice(0, 3)) {
      await book(token, slot.id).expect(201);
    }
    const overCap = await book(token, slots[3]!.id).expect(409);
    expect(overCap.body.error.code).toBe("BOOKING_CAP_REACHED");

    // Release one booking, then hold a different slot and prove the live hold
    // still occupies one of the three seats.
    const appointments = await prisma.appointment.findMany({
      where: { patientId: patient.user.id },
      select: { id: true },
    });
    const toCancel = appointments[0]!;
    await request(app)
      .post(`/api/v1/appointments/${toCancel.id}/cancel`)
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(200);

    await prisma.seatHold.create({
      data: {
        slotId: slots[4]!.id,
        patientId: patient.user.id,
        paymentOrderId: `order_day37_cap_${randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await prisma.slot.update({ where: { id: slots[4]!.id }, data: { heldCount: 1 } });

    const blockedByHold = await book(token, slots[3]!.id).expect(409);
    expect(blockedByHold.body.error.code).toBe("BOOKING_CAP_REACHED");
  });
});
