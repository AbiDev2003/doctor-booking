import { z } from "zod"
import { newPasswordSchema } from "@shared/auth"

/**
 * The confirm field is presentation-only: the API never receives it. The
 * password rule itself comes from the shared auth module, so reset and claim
 * cannot drift from registration.
 */
export const passwordConfirmationSchema = z
  .object({
    password: newPasswordSchema,
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    path: ["confirm"],
    message: "Passwords do not match.",
  })

export type PasswordConfirmationValues = z.infer<typeof passwordConfirmationSchema>
