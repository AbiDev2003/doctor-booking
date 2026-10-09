import { z } from "zod";

/** Public path params: an id is a uuid(7); Prisma would otherwise 500 on a cast. */
export const publicDoctorIdParamSchema = z.object({
  id: z.uuid("Invalid doctor id"),
});

export type PublicDoctorIdParam = z.infer<typeof publicDoctorIdParamSchema>;