import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { createDoctor, createPatient, createSlot } from "./factories.js";

function dateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function expectRejectedBy(constraintName: string, write: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`Expected ${constraintName} to reject the write, but it succeeded.`);
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toContain(constraintName);
}

function appointmentData(slotId: string, patientId: string, doctorId: string) {
  return {
    doctorId,
    patientId,
    slotId,
    doctorName: "Integration Doctor",
    feeAmount: 50_000,
    status: $Enums.AppointmentStatus.CONFIRMED,
  };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 37 chunk 3: database constraints", () => {
  it("enforces one active appointment per patient per slot, while leaving cancelled seats reusable", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id, { date: dateAfter(30) });
    const otherSlot = await createSlot(doctor.id, { date: dateAfter(31) });

    await prisma.appointment.create({
      data: appointmentData(slot.id, patient.id, doctor.id),
    });

    await expectRejectedBy("appointments_active_booking_per_patient_slot_unique", () =>
      prisma.appointment.create({ data: appointmentData(slot.id, patient.id, doctor.id) }),
    );
    await expectRejectedBy("appointments_active_booking_per_patient_slot_unique", () =>
      prisma.appointment.create({
        data: {
          ...(appointmentData(slot.id, patient.id, doctor.id)),
          status: $Enums.AppointmentStatus.ARRIVED,
        },
      }),
    );

    const cancelled = await prisma.appointment.create({
      data: appointmentData(otherSlot.id, patient.id, doctor.id),
    });
    await prisma.appointment.update({
      where: { id: cancelled.id },
      data: { status: $Enums.AppointmentStatus.CANCELLED },
    });

    const rebooked = await prisma.appointment.create({
      data: appointmentData(otherSlot.id, patient.id, doctor.id),
    });
    expect(rebooked.id).toBeTruthy();
  });

  it("allows only one live seat hold per patient, releasing the index on release", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id, { date: dateAfter(30) });
    const otherSlot = await createSlot(doctor.id, { date: dateAfter(31) });
    const orderSuffix = `${Date.now()}-${randomUUID()}`;

    await prisma.seatHold.create({
      data: {
        slotId: slot.id,
        patientId: patient.id,
        paymentOrderId: `order_${orderSuffix}_a`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await expectRejectedBy("seat_holds_one_live_hold_per_patient_unique", () =>
      prisma.seatHold.create({
        data: {
          slotId: otherSlot.id,
          patientId: patient.id,
          paymentOrderId: `order_${orderSuffix}_b`,
          expiresAt: new Date(Date.now() + 600_000),
        },
      }),
    );

    await prisma.seatHold.updateMany({
      where: { patientId: patient.id },
      data: {
        releasedAt: new Date(),
        releaseReason: $Enums.SeatHoldReleaseReason.ABANDONED,
      },
    });

    const secondHold = await prisma.seatHold.create({
      data: {
        slotId: otherSlot.id,
        patientId: patient.id,
        paymentOrderId: `order_${orderSuffix}_c`,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    expect(secondHold.releasedAt).toBeNull();
  });

  it("allows only one REMINDER per appointment and slot but permits other notification types", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);
    const appointment = await prisma.appointment.create({
      data: appointmentData(slot.id, patient.id, doctor.id),
    });
    const recipient = patient.email ?? "day37-integration@example.test";

    await prisma.notification.create({
      data: {
        type: $Enums.NotificationType.REMINDER,
        recipient,
        appointmentId: appointment.id,
        slotId: slot.id,
      },
    });

    await expectRejectedBy("notifications_reminder_once_per_appointment_slot_unique", () =>
      prisma.notification.create({
        data: {
          type: $Enums.NotificationType.REMINDER,
          recipient,
          appointmentId: appointment.id,
          slotId: slot.id,
        },
      }),
    );

    const cancelled = await prisma.notification.create({
      data: {
        type: $Enums.NotificationType.APPOINTMENT_CANCELLED,
        recipient,
        appointmentId: appointment.id,
        slotId: slot.id,
      },
    });
    expect(cancelled.type).toBe($Enums.NotificationType.APPOINTMENT_CANCELLED);
  });

  it("enforces the slot capacity and positive-maximum CHECKs", async () => {
    const doctor = await createDoctor();
    const slot = await createSlot(doctor.id, { maxPatients: 2 });

    await expectRejectedBy("slots_capacity_check", () =>
      prisma.slot.update({
        where: { id: slot.id },
        data: { bookedCount: 3, maxPatients: 2 },
      }),
    );
    await expectRejectedBy("slots_capacity_check", () =>
      prisma.slot.update({
        where: { id: slot.id },
        data: { bookedCount: 1, heldCount: 2 },
      }),
    );
    await expectRejectedBy("slots_max_patients_positive_check", () =>
      prisma.slot.update({ where: { id: slot.id }, data: { maxPatients: 0 } }),
    );

    const exact = await prisma.slot.update({
      where: { id: slot.id },
      data: { bookedCount: 2, heldCount: 0, maxPatients: 2 },
    });
    expect(exact.bookedCount + exact.heldCount).toBe(exact.maxPatients);
  });

  it("enforces the positive payment amount CHECK, including hold-shaped payments", async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const slot = await createSlot(doctor.id);
    const appointment = await prisma.appointment.create({
      data: appointmentData(slot.id, patient.id, doctor.id),
    });

    await expectRejectedBy("payments_amount_paise_positive_check", () =>
      prisma.payment.create({
        data: {
          patientId: patient.id,
          appointmentId: appointment.id,
          amountPaise: 0,
          method: $Enums.PaymentMethod.CASH,
        },
      }),
    );
    await expectRejectedBy("payments_amount_paise_positive_check", () =>
      prisma.payment.create({
        data: {
          patientId: patient.id,
          appointmentId: appointment.id,
          amountPaise: -1,
          method: $Enums.PaymentMethod.CASH,
        },
      }),
    );
    await expectRejectedBy("payments_amount_paise_positive_check", () =>
      prisma.payment.create({ data: { patientId: patient.id, amountPaise: 0 } }),
    );

    const paid = await prisma.payment.create({
      data: {
        patientId: patient.id,
        appointmentId: appointment.id,
        amountPaise: 1,
        method: $Enums.PaymentMethod.CASH,
        status: $Enums.PaymentStatus.PAID,
      },
    });
    expect(paid.amountPaise).toBe(1);
  });
});

describe("§17 payment enum discipline", () => {
  it("keeps SUCCESS on refund_status only, never on payment_status", async () => {
    const labels = await prisma.$queryRaw<Array<{ enum_type: string; enumlabel: string }>>`
      SELECT t.typname AS enum_type, e.enumlabel
      FROM pg_type AS t
      JOIN pg_enum AS e ON e.enumtypid = t.oid
      WHERE t.typnamespace = 'public'::regnamespace
        AND t.typname IN ('payment_status', 'refund_status')
      ORDER BY t.typname, e.enumsortorder
    `;

    const paymentLabels = labels
      .filter((row) => row.enum_type === "payment_status")
      .map((row) => row.enumlabel);
    const refundLabels = labels
      .filter((row) => row.enum_type === "refund_status")
      .map((row) => row.enumlabel);

    expect(paymentLabels).toEqual(["PENDING", "PAID", "FAILED", "VOIDED"]);
    expect(paymentLabels).not.toContain("SUCCESS");
    expect(refundLabels).toContain("SUCCESS");
  });
});
