import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiClaimAccount } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";
import {
  passwordConfirmationSchema,
  type PasswordConfirmationValues,
} from "../lib/passwordForms";

/**
 * §5.1 claim portal — where an invited doctor, staff member or admin sets
 * their first password. Deliberately a page of its own, not a reuse of
 * /reset-password (decision D1): the two flows share a token mechanic but
 * not a story. A reset says "you forgot"; this says "you were invited" —
 * and the token behind it has its own purpose and a 24-hour lifetime
 * (decision D3), so collapsing them would make one page's copy a lie about
 * the other flow's expiry.
 *
 * The page reads the token from the query string and never echoes it back on
 * error — the server answers a bad, expired or already-used token with one
 * generic message (no oracle for which), and this page repeats it verbatim
 * on the banner rather than narrowing it here.
 */
export default function ClaimAccount() {
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
      await apiClaimAccount({ token, password: values.password });
      setDone(true);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  if (missingToken) {
    return (
      <main className="card">
        <h1>Invitation invalid</h1>
        <p role="alert">
          This page is missing its invitation token. Open the link from your email, or ask your
          administrator to send a new invitation.
        </p>
        <Link className="button-link" to="/login">
          Go to sign in
        </Link>
      </main>
    );
  }

  if (done) {
    return (
      <main className="card">
        <h1>Account activated</h1>
        <p>Your password is set. You can now sign in with your email address.</p>
        <Link className="button-link" to="/login">
          Sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Activate your account</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="password">Choose a password</label>
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

        <label htmlFor="confirm">Confirm password</label>
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
          {isSubmitting ? "Activating…" : "Activate account"}
        </button>
      </form>

      <p className="hint">Invitation links expire after 24 hours and work only once.</p>
    </main>
  );
}
