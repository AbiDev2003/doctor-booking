import { z } from "zod";

/** Admin review of a doctor-proposed schedule/time-off change. */
export const doctorScheduleRequestIdParamSchema = z.object({
  id: z.uuid("Invalid schedule change request id"),
});

export type DoctorScheduleRequestIdParam = z.infer<typeof doctorScheduleRequestIdParamSchema>;

export const adminDoctorScheduleRequestsQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
  doctorId: z.uuid("Invalid doctor id").optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type AdminDoctorScheduleRequestsQueryShape = z.infer<
  typeof adminDoctorScheduleRequestsQuerySchema
>;
