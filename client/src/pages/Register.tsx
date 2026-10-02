import { useState } from "react";
import type { FormEvent } from "react";
import { apiRegister, ApiError } from "../lib/api";

type FieldErrors = Record<string, string>;

const EMPTY = { email: "", password: "", fullName: "", phone: "" };

export default function Register() {
  const [values, setValues] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
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
      await apiRegister(values);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        // EMAIL/PHONE_ALREADY_EXISTS land on the field that caused them; the
        // 422 path already populated fieldErrors.
        if (err.code === "EMAIL_ALREADY_EXISTS") {
          setFieldErrors({ email: err.message });
        } else if (err.code === "PHONE_ALREADY_EXISTS") {
          setFieldErrors({ phone: err.message });
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

  if (done) {
    return (
      <main className="card">
        <h1>Check your email</h1>
        <p>
          We sent a verification link to <strong>{values.email}</strong>. Open it to activate your account.
        </p>
        <p className="hint">
          The link expires in 15 minutes. Until you verify, you won&apos;t be able to book an appointment.
        </p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Create your account</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="fullName">Full name</label>
        <input
          id="fullName"
          name="fullName"
          value={values.fullName}
          onChange={(e) => update("fullName", e.target.value)}
          autoComplete="name"
        />
        {fieldErrors.fullName && <span className="field-error">{fieldErrors.fullName}</span>}

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

        <label htmlFor="phone">Phone</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          value={values.phone}
          onChange={(e) => update("phone", e.target.value)}
          autoComplete="tel"
          placeholder="9876543210"
        />
        {fieldErrors.phone && <span className="field-error">{fieldErrors.phone}</span>}

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={values.password}
          onChange={(e) => update("password", e.target.value)}
          autoComplete="new-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </main>
  );
}