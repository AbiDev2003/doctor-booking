import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiResetPassword, ApiError } from "../lib/api";

type FieldErrors = Record<string, string>;

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

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (password !== confirm) {
      setFieldErrors({ confirm: "Passwords do not match." });
      return;
    }

    setSubmitting(true);
    try {
      await apiResetPassword({ token, password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        // INVALID_OR_EXPIRED_TOKEN covers wrong, expired, and already-used
        // tokens with one message (§6.2 — no oracle for which), and lands on
        // no particular field, so it belongs on the banner.
        if (err.code === "INVALID_OR_EXPIRED_TOKEN") {
          setFormError(err.message);
        } else if (err.fields.length === 0) {
          setFormError(err.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

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
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

        <label htmlFor="confirm">Confirm new password</label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.confirm && <span className="field-error">{fieldErrors.confirm}</span>}

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>

      <p className="hint">Codes and links expire after 15 minutes and work only once.</p>
    </main>
  );
}
