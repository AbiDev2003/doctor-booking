import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { $Enums } from "../../src/generated/prisma/client.js";
import { prisma } from "../../src/lib/prisma.js";
import { createAdmin, createClinic, createLoginDoctor } from "./factories.js";

const app = createApp();

async function login(email: string | null, password: string): Promise<string> {
  if (email === null) throw new Error("Login fixture must have an email");
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password })
    .expect(200);
  return response.body.accessToken as string;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("doctor credential change approval", () => {
  it("keeps the doctor live, notifies admins, and applies only approved values", async () => {
    await createClinic();
    const doctorAccount = await createLoginDoctor({ fullName: "Approval Doctor" });
    const admin = await createAdmin();
    const [doctorToken, adminToken] = await Promise.all([
      login(doctorAccount.user.email, doctorAccount.password),
      login(admin.user.email, admin.password),
    ]);
    const doctorId = doctorAccount.user.id;

    const proposal = await request(app)
      .patch(`/api/v1/doctors/${doctorId}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        qualification: "MD Cardiology",
        licenseNumber: "APPROVED-LICENSE",
        specialization: "Cardiology",
      })
      .expect(200);

    expect(proposal.body.credentialChangeSubmitted).toBe(true);
    expect(proposal.body.verificationStatus).toBe("VERIFIED");
    expect(proposal.body.credentialChangeRequestId).toEqual(expect.any(String));

    const live = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorId } });
    expect(live.qualification).toBe("MBBS");
    expect(live.licenseNumber).not.toBe("APPROVED-LICENSE");
    expect(live.verificationStatus).toBe($Enums.DoctorVerificationStatus.VERIFIED);

    const beforePublic = await request(app).get(`/api/v1/public/doctors/${doctorId}`).expect(200);
    expect(beforePublic.body.doctor.id).toBe(doctorId);
    expect(beforePublic.body.doctor.qualification).toBe("MBBS");

    const pending = await prisma.doctorCredentialChangeRequest.findFirstOrThrow({
      where: { doctorId, status: $Enums.DoctorCredentialChangeStatus.PENDING },
    });
    expect(pending.requestedChanges).toMatchObject({
      qualification: "MD Cardiology",
      licenseNumber: "APPROVED-LICENSE",
      specialization: "Cardiology",
    });

    const notifications = await prisma.notification.findMany({
      where: {
        type: $Enums.NotificationType.DOCTOR_CREDENTIAL_CHANGE_REQUESTED,
        recipient: admin.user.email ?? "",
      },
    });
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    const adminQueue = await request(app)
      .get("/api/v1/admin/doctor-credential-requests?status=PENDING")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(adminQueue.body.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.id,
          doctorId,
          doctorName: "Approval Doctor",
          doctorEmail: doctorAccount.user.email,
          status: "PENDING",
        }),
      ]),
    );

    await request(app)
      .get("/api/v1/admin/doctor-credential-requests")
      .set("Authorization", `Bearer ${doctorToken}`)
      .expect(403);

    const approved = await request(app)
      .post(`/api/v1/admin/doctor-credential-requests/${pending.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Verified documents" })
      .expect(200);
    expect(approved.body.status).toBe("APPROVED");

    const afterApproval = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorId } });
    expect(afterApproval.qualification).toBe("MD Cardiology");
    expect(afterApproval.licenseNumber).toBe("APPROVED-LICENSE");
    expect(afterApproval.specialization).toBe("Cardiology");
    expect(afterApproval.verificationStatus).toBe($Enums.DoctorVerificationStatus.VERIFIED);

    const afterPublic = await request(app).get(`/api/v1/public/doctors/${doctorId}`).expect(200);
    expect(afterPublic.body.doctor.id).toBe(doctorId);
    expect(afterPublic.body.doctor.qualification).toBe("MD Cardiology");

    const secondProposal = await request(app)
      .patch(`/api/v1/doctors/${doctorId}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ licenseNumber: "REJECTED-LICENSE" })
      .expect(200);
    const rejectedId = secondProposal.body.credentialChangeRequestId as string;

    const rejected = await request(app)
      .post(`/api/v1/admin/doctor-credential-requests/${rejectedId}/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "License number could not be verified" })
      .expect(200);
    expect(rejected.body.status).toBe("REJECTED");

    const afterReject = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctorId } });
    expect(afterReject.licenseNumber).toBe("APPROVED-LICENSE");
    expect(afterReject.verificationStatus).toBe($Enums.DoctorVerificationStatus.VERIFIED);
  });
});
