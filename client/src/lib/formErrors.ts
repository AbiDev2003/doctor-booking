import type { FieldValues, Path, UseFormSetError } from "react-hook-form"
import { ApiError } from "@/lib/api"

/**
 * Map a server error envelope onto a react-hook-form.
 *
 * The client validates with the same shared Zod schema as the API, so a field
 * error here is normally a rule the server enforces beyond the shape (email
 * already used, phone not a patient, and so on). When the server returns no
 * field paths, the caller gets a form-level message to render in the banner.
 */
export function applyApiErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): string | undefined {
  if (!(error instanceof ApiError)) {
    return "Something went wrong. Please try again."
  }

  for (const field of error.fields) {
    setError(field.path as Path<T>, { type: "server", message: field.message })
  }

  return error.fields.length === 0 ? error.message : undefined
}
