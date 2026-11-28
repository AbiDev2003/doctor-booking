import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  createAdmin,
  createClinic,
  createDoctor,
  createLoginDoctor,
  createLoginPatient,
  createPatient,
  createSlot,
  createStaff,
} from "./factories.js";

const app = createApp();

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function tokenFor(email: string | null, password: string): Promise<string> {
  if (email === null) throw new Error("Login fixture must have an email.");
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password })
    .expect(200);
  return response.body.accessToken as string;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("staff appointment history", () => {
  it("serves the same clinic-wide rows and live action flags as admin History", async () => {
    await createClinic();
    const staff = await createStaff();
    const admin = await createAdmin();
    const doctor = await createDoctor();
    const patient = await createPatient({ fullName: "History Patient" });
    const [staffToken, adminToken] = await Promise.all([
      tokenFor(staff.user.email, staff.password),
      tokenFor(admin.user.email, admin.password),
    ]);

    const pastDate = dateOffset(-2);
    const pastSlot = await createSlot(doctor.id, {
      date: pastDate,
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
      .get("/api/v1/appointments/history?scope=needsAttention")
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    const rows = scoped.body.appointments as {
      id: string;
      canNoShow: boolean;
      patient: { fullName: string; phone: string };
    }[];
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id);

    const pastRow = rows.find((row) => row.id === past.id)!;
    expect(pastRow.canNoShow).toBe(true);
    expect(pastRow.patient.fullName).toBe("History Patient");
    expect(pastRow.patient.phone).not.toBe("");

    const virtualStatus = await request(app)
      .get("/api/v1/appointments/history?status=NEEDS_ATTENTION")
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    expect((virtualStatus.body.appointments as { id: string }[]).map((row) => row.id)).toContain(past.id);

    const byDate = await request(app)
      .get(`/api/v1/appointments/history?date=${pastDate}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    const dateIds = (byDate.body.appointments as { id: string }[]).map((row) => row.id);
    expect(dateIds).toContain(past.id);
    expect(dateIds).not.toContain(future.id);

    const bySearch = await request(app)
      .get(`/api/v1/appointments/history?search=History%20Patient&doctorId=${doctor.id}`)
      .set("Authorization", `Bearer ${staffToken}`)
      .expect(200);
    expect((bySearch.body.appointments as { id: string }[]).map((row) => row.id)).toContain(past.id);

    // The same read remains available to admin, and stays closed to non-desk roles.
    const adminView = await request(app)
      .get("/api/v1/appointments/history?scope=needsAttention")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect((adminView.body.appointments as { id: string }[]).map((row) => row.id)).toContain(past.id);

    const patientAccount = await createLoginPatient();
    const patientToken = await tokenFor(patientAccount.user.email, patientAccount.password);
    await request(app)
      .get("/api/v1/appointments/history")
      .set("Authorization", `Bearer ${patientToken}`)
      .expect(403);

    const doctorAccount = await createLoginDoctor();
    const doctorToken = await tokenFor(doctorAccount.user.email, doctorAccount.password);
    await request(app)
      .get("/api/v1/appointments/history")
      .set("Authorization", `Bearer ${doctorToken}`)
      .expect(403);
  });
});
