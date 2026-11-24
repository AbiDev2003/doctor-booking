import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  createAdmin,
  createClinic,
  createLoginDoctor,
  createLoginPatient,
  createSlot,
  createStaff,
  uniquePhone,
} from "./factories.js";

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

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Day 36 chunk 3: role authorization and ownership", () => {
  it("applies authentication and admin-only audit access", async () => {
    const patient = await createLoginPatient();
    const staff = await createStaff();
    const admin = await createAdmin();
    const [patientToken, staffToken, adminToken] = await Promise.all([
      accessToken(patient.user.email, patient.password),
      accessToken(staff.user.email, staff.password),
      accessToken(admin.user.email, admin.password),
    ]);

    await request(app).get("/api/v1/audit").expect(401);
    for (const token of [patientToken, staffToken]) {
      const forbidden = await request(app)
        .get("/api/v1/audit")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
      expect(forbidden.body.error.code).toBe("FORBIDDEN");
    }

    await request(app)
      .get("/api/v1/audit")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
  });

  it("limits doctors to their own profile and schedules", async () => {
    const doctor = await createLoginDoctor();
    const otherDoctor = await createLoginDoctor();
    const token = await accessToken(doctor.user.email, doctor.password);

    await request(app)
      .get(`/api/v1/doctors/${doctor.user.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const profile = await request(app)
      .get(`/api/v1/doctors/${otherDoctor.user.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(profile.body.error.code).toBe("FORBIDDEN");

    const ownSchedules = await request(app)
      .get("/api/v1/schedules")
      .query({ doctorId: doctor.user.id })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(ownSchedules.body.schedules).toEqual([]);

    const otherSchedules = await request(app)
      .get("/api/v1/schedules")
      .query({ doctorId: otherDoctor.user.id })
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(otherSchedules.body.error.code).toBe("FORBIDDEN");
  });

  it("keeps appointment details scoped to the owning patient", async () => {
    await createClinic();
    const doctor = await createLoginDoctor();
    const owner = await createLoginPatient();
    const otherPatient = await createLoginPatient();
    const slot = await createSlot(doctor.user.id);
    const appointment = await prisma.appointment.create({
      data: {
        doctorId: doctor.user.id,
        patientId: owner.user.id,
        slotId: slot.id,
        status: $Enums.AppointmentStatus.CONFIRMED,
        doctorName: doctor.user.fullName,
        feeAmount: 50_000,
      },
    });
    const [ownerToken, otherPatientToken] = await Promise.all([
      accessToken(owner.user.email, owner.password),
      accessToken(otherPatient.user.email, otherPatient.password),
    ]);

    const ownAppointment = await request(app)
      .get(`/api/v1/appointments/${appointment.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownAppointment.body.appointment.id).toBe(appointment.id);

    const foreignAppointment = await request(app)
      .get(`/api/v1/appointments/${appointment.id}`)
      .set("Authorization", `Bearer ${otherPatientToken}`)
      .expect(403);
    expect(foreignAppointment.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a desk patient whose email belongs to another account", async () => {
    await createClinic();
    const doctor = await createLoginDoctor();
    const staff = await createStaff();
    const existing = await createLoginPatient();
    const slot = await createSlot(doctor.user.id);
    const token = await accessToken(staff.user.email, staff.password);

    const response = await request(app)
      .post("/api/v1/appointments/desk")
      .set("Authorization", `Bearer ${token}`)
      .send({
        slotId: slot.id,
        patient: {
          fullName: "Duplicate Desk Patient",
          phone: uniquePhone(),
          email: existing.user.email,
        },
      })
      .expect(409);

    expect(response.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
    expect(await prisma.user.count({ where: { email: existing.user.email } })).toBe(1);
    expect(await prisma.appointment.count({ where: { slotId: slot.id } })).toBe(0);
  });
});
