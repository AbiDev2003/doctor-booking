import { afterAll, describe, expect, it, vi } from "vitest";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { createAdmin, createClinic, createDoctor, createPatient, createSlot } from "./factories.js";
import { sendUnclosedBookingReminders } from "../../src/jobs/unclosedBookingReminder.js";

vi.mock("../../src/services/notifications/notification.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/notifications/notification.service.js")>();
  return { ...actual, dispatchNotificationInBackground: vi.fn() };
});

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("unclosed booking follow-up", () => {
  it("queues one follow-up per past CONFIRMED booking and never changes its status", async () => {
    await createClinic();
    await createAdmin();
    const doctor = await createDoctor();
    const patient = await createPatient();

    const pastSlot = await createSlot(doctor.id, {
      date: dateOffset(-1),
      startTime: "09:00",
      endTime: "10:00",
    });
    const futureSlot = await createSlot(doctor.id, { date: dateOffset(30) });

    const past = await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: pastSlot.id,
        status: $Enums.AppointmentStatus.CONFIRMED,
        doctorName: doctor.fullName,
        feeAmount: 0,
        bookingTime: new Date(),
      },
    });
    await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: patient.id,
        slotId: futureSlot.id,
        status: $Enums.AppointmentStatus.CONFIRMED,
        doctorName: doctor.fullName,
        feeAmount: 0,
        bookingTime: new Date(),
      },
    });

    const where = {
      appointmentId: past.id,
      type: $Enums.NotificationType.APPOINTMENT_ATTENDANCE_FOLLOW_UP,
    };

    expect(await sendUnclosedBookingReminders(new Date())).toBeGreaterThanOrEqual(1);
    // Every active staff/admin account is a recipient, so the exact count is
    // fixture-dependent; one per recipient is enforced by the partial index.
    const firstCount = await prisma.notification.count({ where });
    expect(firstCount).toBeGreaterThanOrEqual(1);
    const recipients = await prisma.notification.findMany({ where, select: { recipient: true } });
    expect(new Set(recipients.map((row) => row.recipient)).size).toBe(firstCount);

    const afterFirst = await prisma.appointment.findUniqueOrThrow({ where: { id: past.id } });
    expect(afterFirst.status).toBe($Enums.AppointmentStatus.CONFIRMED);

    expect(await sendUnclosedBookingReminders(new Date())).toBe(0);
    expect(await prisma.notification.count({ where })).toBe(firstCount);
  });
});
