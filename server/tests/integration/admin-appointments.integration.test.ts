import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { createAdmin, createClinic, createDoctor, createPatient, createSlot } from "./factories.js";

const app = createApp();

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function adminToken(): Promise<string> {
  const admin = await createAdmin();
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: admin.user.email, password: admin.password })
    .expect(200);
  return response.body.accessToken as string;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("admin appointment history: needs-attention filters and actions", () => {
  it("returns past CONFIRMED rows with desk action flags, and excludes future ones", async () => {
    await createClinic();
    const token = await adminToken();
    const doctor = await createDoctor();
    const patient = await createPatient();

    const pastSlot = await createSlot(doctor.id, {
      date: dateOffset(-2),
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
    const future = await prisma.appointment.create({
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

    const scoped = await request(app)
      .get("/api/v1/admin/appointments?scope=needsAttention")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const ids = (scoped.body.appointments as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id);

    const pastRow = (scoped.body.appointments as { id: string; canNoShow: boolean; patient: { fullName: string } }[])
      .find((row) => row.id === past.id)!;
    expect(pastRow.canNoShow).toBe(true);
    expect(pastRow.patient.fullName).toBe(patient.fullName);

    const virtualStatus = await request(app)
      .get("/api/v1/admin/appointments?status=NEEDS_ATTENTION")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect((virtualStatus.body.appointments as { id: string }[]).map((row) => row.id)).toContain(past.id);

    const overview = await request(app)
      .get("/api/v1/admin/overview")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(overview.body.overview.appointments.unclosedPast).toBeGreaterThanOrEqual(1);
  });
});
