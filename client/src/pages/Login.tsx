import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiLogin, ApiError } from "../lib/api";

type FieldErrors = Record<string, string>;

const EMPTY = { email: "", password: "" };

export default function Login() {
  const navigate = useNavigate();
  const [values, setValues] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(name: keyof typeof EMPTY, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await apiLogin(values);
      // Every role lands on the account page for now; role-specific dashboards
      // arrive with their days (patient Day 13, doctor Day 34, staff Day 37).
      navigate("/profile");
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        // §6.3: wrong credentials share one message (no account enumeration),
        // and lockout/hold/suspend answers are terminal 4xx that belong on the
        // form banner, not on a field the user did not fill wrong.
        if (err.code === "INVALID_CREDENTIALS") {
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

  return (
    <main className="card">
      <h1>Sign in</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={values.email}
          onChange={(e) => update("email", e.target.value)}
          autoComplete="email"
        />
        {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={values.password}
          onChange={(e) => update("password", e.target.value)}
          autoComplete="current-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="hint">
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="hint">
        No account yet? <Link to="/register">Create one</Link>.
      </p>
    </main>
  );
}
