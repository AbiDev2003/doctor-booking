import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiResetPassword } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";
import {
  passwordConfirmationSchema,
  type PasswordConfirmationValues,
} from "../lib/passwordForms";

/**
 * §6.2 reset portal — the single destination for BOTH delivery methods: the
 * emailed link carries the token in its query string, and the OTP typed on the
 * forgot-password page is carried here the same way. One portal means one
 * validation path, one single-use claim, and one place to get the wording
 * right.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const missingToken = token.length === 0;

  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordConfirmationValues>({
    resolver: zodResolver(passwordConfirmationSchema),
    defaultValues: { password: "", confirm: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      await apiResetPassword({ token, password: values.password });
      setDone(true);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  if (missingToken) {
    return (
      <main className="card">
        <h1>Reset failed</h1>
        <p role="alert">
          This page is missing its recovery token. Open the link from your email, or request a new code.
        </p>
        <Link className="button-link" to="/forgot-password">
          Request a new link or code
        </Link>
      </main>
    );
  }

  if (done) {
    return (
      <main className="card">
        <h1>Password updated</h1>
        <p>Your password has been changed and every other session was signed out.</p>
        <Link className="button-link" to="/login">
          Sign in with your new password
        </Link>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Choose a new password</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="password">New password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password !== undefined ? "password-error" : undefined}
          {...register("password")}
        />
        {errors.password?.message !== undefined && (
          <span id="password-error" className="field-error" role="alert">
            {errors.password.message}
          </span>
        )}

        <label htmlFor="confirm">Confirm new password</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.confirm !== undefined}
          aria-describedby={errors.confirm !== undefined ? "confirm-error" : undefined}
          {...register("confirm")}
        />
        {errors.confirm?.message !== undefined && (
          <span id="confirm-error" className="field-error" role="alert">
            {errors.confirm.message}
          </span>
        )}

        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Updating…" : "Update password"}
        </button>
      </form>

      <p className="hint">Codes and links expire after 15 minutes and work only once.</p>
    </main>
  );
}
