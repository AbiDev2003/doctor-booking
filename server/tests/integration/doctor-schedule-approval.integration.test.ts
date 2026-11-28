import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import {
  createAdmin,
  createClinic,
  createLoginDoctor,
  createPatient,
  createSlot,
  createStaff,
  TEST_PASSWORD,
} from "./factories.js";

const app = createApp();
const API = "/api/v1";

interface Account {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

let admin: Account;
let staff: Account;

async function login(email: string, password = TEST_PASSWORD): Promise<string> {
  const response = await request(app).post(`${API}/auth/login`).send({ email, password }).expect(200);
  return response.body.accessToken as string;
}

async function newDoctor(fullName: string): Promise<Account> {
  const account = await createLoginDoctor({ fullName });
  if (account.user.email === null) throw new Error("Doctor fixture must have an email");
  return {
    id: account.user.id,
    email: account.user.email,
    token: await login(account.user.email, account.password),
  };
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function confirmedBooking(doctorId: string, slotId: string) {
  const patient = await createPatient();
  return prisma.appointment.create({
    data: {
      doctorId,
      patientId: patient.id,
      slotId,
      status: $Enums.AppointmentStatus.CONFIRMED,
      doctorName: "Schedule Approval Doctor",
      feeAmount: 0,
      bookingTime: new Date(),
    },
  });
}

beforeAll(async () => {
  await createClinic();
  const adminAccount = await createAdmin();
  const staffAccount = await createStaff();
  if (adminAccount.user.email === null || staffAccount.user.email === null) {
    throw new Error("Admin/staff fixtures must have emails");
  }
  admin = {
    id: adminAccount.user.id,
    email: adminAccount.user.email,
    token: await login(adminAccount.user.email, adminAccount.password),
  };
  staff = {
    id: staffAccount.user.id,
    email: staffAccount.user.email,
    token: await login(staffAccount.user.email, staffAccount.password),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("doctor schedule and time-off approval", () => {
  it("queues a window proposal, then applies it only after admin approval", async () => {
    const doctor = await newDoctor("Window Approval Doctor");

    const proposal = await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "TUE", startTime: "09:00", endTime: "12:00", maxPatients: 6 })
      .expect(202);

    expect(proposal.body.message).toMatch(/approval/i);
    expect(proposal.body.scheduleRequest.status).toBe("PENDING");
    const requestId = proposal.body.scheduleRequest.id as string;

    expect(await prisma.schedule.count({ where: { doctorId: doctor.id } })).toBe(0);
    expect(await prisma.slot.count({ where: { doctorId: doctor.id } })).toBe(0);

    const queuedNotification = await prisma.notification.findFirst({
      where: {
        type: $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_REQUESTED,
        recipient: admin.email,
      },
    });
    expect(queuedNotification).not.toBeNull();

    const submittedAudit = await prisma.auditLog.findFirst({
      where: {
        action: "DOCTOR_SCHEDULE_CHANGE_REQUESTED",
        targetId: requestId,
      },
    });
    expect(submittedAudit).not.toBeNull();

    const ownRequests = await request(app).get(`${API}/schedules/requests`).set(auth(doctor.token)).expect(200);
    expect(ownRequests.body.requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: requestId, status: "PENDING" })]),
    );

    const queue = await request(app)
      .get(`${API}/admin/doctor-schedule-requests?status=PENDING`)
      .set(auth(admin.token))
      .expect(200);
    expect(queue.body.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requestId,
          doctorId: doctor.id,
          doctorName: "Window Approval Doctor",
          status: "PENDING",
        }),
      ]),
    );

    await request(app).get(`${API}/admin/doctor-schedule-requests`).set(auth(doctor.token)).expect(403);

    const approved = await request(app)
      .post(`${API}/admin/doctor-schedule-requests/${requestId}/approve`)
      .set(auth(admin.token))
      .send({ reason: "Approved by admin" })
      .expect(200);
    expect(approved.body.status).toBe("APPROVED");

    const liveWindow = await prisma.schedule.findFirstOrThrow({ where: { doctorId: doctor.id } });
    expect(liveWindow.weekday).toBe($Enums.Weekday.TUE);
    expect(liveWindow.maxPatients).toBe(6);

    const stored = await prisma.doctorScheduleChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(stored.status).toBe($Enums.DoctorScheduleChangeStatus.APPROVED);
    expect(stored.reviewNote).toBe("Approved by admin");

    const decision = await prisma.notification.findFirst({
      where: {
        type: $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_APPROVED,
        recipient: doctor.email,
      },
    });
    expect(decision).not.toBeNull();

    const approvalAudit = await prisma.auditLog.findFirst({
      where: { action: "DOCTOR_SCHEDULE_CHANGE_APPROVED", targetId: requestId },
    });
    expect(approvalAudit).not.toBeNull();
  });

  it("rejects a pending window without touching the live template", async () => {
    const doctor = await newDoctor("Window Rejection Doctor");
    const proposal = await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "WED", startTime: "14:00", endTime: "16:00", maxPatients: 4 })
      .expect(202);
    const requestId = proposal.body.scheduleRequest.id as string;

    const rejected = await request(app)
      .post(`${API}/admin/doctor-schedule-requests/${requestId}/reject`)
      .set(auth(admin.token))
      .send({ reason: "Use Thursday instead" })
      .expect(200);
    expect(rejected.body.status).toBe("REJECTED");

    expect(await prisma.schedule.count({ where: { doctorId: doctor.id } })).toBe(0);
    const decision = await prisma.notification.findFirst({
      where: {
        type: $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_REJECTED,
        recipient: doctor.email,
      },
    });
    expect(decision).not.toBeNull();
  });

  it("does not hide slots or flag patients until time off is approved", async () => {
    const doctor = await newDoctor("Time Off Approval Doctor");
    const slot = await createSlot(doctor.id, { startTime: "09:00", endTime: "10:00" });
    const date = slot.slotDate.toISOString().slice(0, 10);
    const appointment = await confirmedBooking(doctor.id, slot.id);

    const proposal = await request(app)
      .post(`${API}/unavailabilities`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, date, startTime: "09:00", endTime: "13:00", reason: "Family commitment" })
      .expect(202);
    const requestId = proposal.body.scheduleRequest.id as string;

    expect(await prisma.doctorUnavailability.count({ where: { doctorId: doctor.id } })).toBe(0);
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(before.status).toBe($Enums.AppointmentStatus.CONFIRMED);
    expect(before.doctorUnavailabilityId).toBeNull();

    const stored = await prisma.doctorScheduleChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(stored.affectedPreview).toBe(1);
    expect(stored.details).toEqual(expect.arrayContaining(["Confirmed bookings that would be affected: 1"]));

    await request(app)
      .post(`${API}/admin/doctor-schedule-requests/${requestId}/approve`)
      .set(auth(admin.token))
      .send({})
      .expect(200);

    const unavailability = await prisma.doctorUnavailability.findFirstOrThrow({ where: { doctorId: doctor.id } });
    expect(unavailability.reason).toBe("Family commitment");
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(after.doctorUnavailabilityId).toBe(unavailability.id);
    expect(after.status).toBe($Enums.AppointmentStatus.CONFIRMED);

    const patientNotice = await prisma.notification.findFirst({
      where: { type: $Enums.NotificationType.DOCTOR_UNAVAILABLE, appointmentId: appointment.id },
    });
    expect(patientNotice).not.toBeNull();
  });

  it("keeps an existing time off window active when a removal request is rejected", async () => {
    const doctor = await newDoctor("Time Off Rejection Doctor");
    const slot = await createSlot(doctor.id, { startTime: "09:00", endTime: "10:00" });
    const existing = await prisma.doctorUnavailability.create({
      data: {
        doctorId: doctor.id,
        createdById: doctor.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: "Existing time off",
      },
    });

    const proposal = await request(app)
      .delete(`${API}/unavailabilities/${existing.id}`)
      .set(auth(doctor.token))
      .send({ reason: "Plans changed" })
      .expect(202);
    const requestId = proposal.body.scheduleRequest.id as string;

    expect(
      await prisma.doctorUnavailability.count({ where: { id: existing.id } }),
    ).toBe(1);

    await request(app)
      .post(`${API}/admin/doctor-schedule-requests/${requestId}/reject`)
      .set(auth(admin.token))
      .send({ reason: "Keep the existing time off" })
      .expect(200);

    const stillThere = await prisma.doctorUnavailability.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stillThere.reason).toBe("Existing time off");
    const decision = await prisma.notification.findFirst({
      where: {
        type: $Enums.NotificationType.DOCTOR_SCHEDULE_CHANGE_REJECTED,
        recipient: doctor.email,
      },
    });
    expect(decision).not.toBeNull();
  });

  it("rate-limits submissions, blocks conflicting pending work, and allows independent requests", async () => {
    const doctor = await newDoctor("Cooldown Doctor");

    await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "MON", startTime: "09:00", endTime: "12:00", maxPatients: 5 })
      .expect(202);

    const tooSoon = await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "FRI", startTime: "09:00", endTime: "12:00", maxPatients: 5 })
      .expect(429);
    expect(tooSoon.body.error.code).toBe("SCHEDULE_REQUEST_TOO_SOON");

    const first = await prisma.doctorScheduleChangeRequest.findFirstOrThrow({
      where: { doctorId: doctor.id, status: $Enums.DoctorScheduleChangeStatus.PENDING },
    });
    await prisma.doctorScheduleChangeRequest.update({
      where: { id: first.id },
      data: { requestedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const conflict = await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "MON", startTime: "10:00", endTime: "13:00", maxPatients: 5 })
      .expect(409);
    expect(conflict.body.error.code).toBe("SCHEDULE_CHANGE_CONFLICT");

    const independent = await request(app)
      .post(`${API}/schedules`)
      .set(auth(doctor.token))
      .send({ doctorId: doctor.id, weekday: "WED", startTime: "09:00", endTime: "12:00", maxPatients: 5 })
      .expect(202);
    expect(independent.body.scheduleRequest.id).not.toBe(first.id);

    expect(
      await prisma.doctorScheduleChangeRequest.count({
        where: { doctorId: doctor.id, status: $Enums.DoctorScheduleChangeStatus.PENDING },
      }),
    ).toBe(2);

    const live = await prisma.schedule.create({
      data: {
        doctorId: doctor.id,
        weekday: $Enums.Weekday.THU,
        startTime: new Date("1970-01-01T09:00:00.000Z"),
        endTime: new Date("1970-01-01T10:00:00.000Z"),
        maxPatients: 5,
      },
    });
    const capacity = await request(app)
      .patch(`${API}/schedules/${live.id}`)
      .set(auth(doctor.token))
      .send({ maxPatients: 20, reason: "More seats" })
      .expect(403);
    expect(capacity.body.error.code).toBe("FORBIDDEN");
  });

  it("keeps admin and staff direct schedule writes immediate", async () => {
    const doctor = await newDoctor("Direct Write Doctor");

    const adminWindow = await request(app)
      .post(`${API}/schedules`)
      .set(auth(admin.token))
      .send({ doctorId: doctor.id, weekday: "THU", startTime: "09:00", endTime: "10:00", maxPatients: 7, reason: "Admin" })
      .expect(201);
    expect(adminWindow.body.schedule.maxPatients).toBe(7);
    expect(adminWindow.body.materialized).not.toBeUndefined();

    const staffWindow = await request(app)
      .post(`${API}/schedules`)
      .set(auth(staff.token))
      .send({ doctorId: doctor.id, weekday: "FRI", startTime: "11:00", endTime: "12:00", maxPatients: 3, reason: "Staff" })
      .expect(201);
    expect(staffWindow.body.schedule.maxPatients).toBe(3);

    const directTimeOff = await request(app)
      .post(`${API}/unavailabilities`)
      .set(auth(staff.token))
      .send({ doctorId: doctor.id, date: "2026-12-15", startTime: "13:00", endTime: "14:00", reason: "Staff bookmark" })
      .expect(201);
    expect(directTimeOff.body.unavailability.reason).toBe("Staff bookmark");

    expect(await prisma.doctorScheduleChangeRequest.count({ where: { doctorId: doctor.id } })).toBe(0);
  });
});
