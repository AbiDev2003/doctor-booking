import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiClaimAccount, ApiError } from "../lib/api";

type FieldErrors = Record<string, string>;

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
      await apiClaimAccount({ token, password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.code === "INVALID_OR_EXPIRED_TOKEN" || err.code === "ACCOUNT_DEACTIVATED") {
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
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

        <label htmlFor="confirm">Confirm password</label>
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
          {submitting ? "Activating…" : "Activate account"}
        </button>
      </form>

      <p className="hint">Invitation links expire after 24 hours and work only once.</p>
    </main>
  );
}
