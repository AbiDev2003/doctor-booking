import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiForgotPassword, ApiError } from "../lib/api";

type FieldErrors = Record<string, string>;

/**
 * §6.2 recovery: the response is deliberately identical for known and unknown
 * addresses (the server decides what that copy is), so this page never hints
 * either way — it echoes the server's message verbatim.
 *
 * Two delivery methods behind one form: `link` emails a URL opening the reset
 * portal directly; `otp` emails a 6-digit code that is typed below and carried
 * to the same portal as the `token` query parameter. Both are interchangeable
 * and both are worthless after 15 minutes.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [method, setMethod] = useState<"link" | "otp">("link");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const result = await apiForgotPassword({ email, method });
      setSent(result.message);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.fields.length === 0) setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function onOtpContinue() {
    // Client-side shape check only (the server re-validates everything) — it
    // exists so a half-typed code does not cost a round trip that will 400.
    if (!/^\d{6}$/.test(otp)) {
      setOtpError("Enter the 6-digit code.");
      return;
    }
    setOtpError(null);
    navigate(`/reset-password?token=${encodeURIComponent(otp)}`);
  }

  if (sent !== null) {
    return (
      <main className="card">
        <h1>Check your email</h1>
        <p role="status">{sent}</p>

        {method === "otp" && (
          <>
            <label htmlFor="otp">Enter your code</label>
            <input
              id="otp"
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              onChange={(e) => {
                setOtp(e.target.value);
                setOtpError(null);
              }}
            />
            {otpError && <span className="field-error">{otpError}</span>}
            <button type="button" onClick={onOtpContinue}>
              Continue
            </button>
          </>
        )}

        <p className="hint">
          The code and any link expire in 15 minutes and can only be used once.{" "}
          <Link to="/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Reset your password</h1>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}

        <fieldset className="radio-row">
          <legend>How should we reach you?</legend>
          <label>
            <input
              type="radio"
              name="method"
              value="link"
              checked={method === "link"}
              onChange={() => setMethod("link")}
            />{" "}
            Send a reset link
          </label>
          <label>
            <input
              type="radio"
              name="method"
              value="otp"
              checked={method === "otp"}
              onChange={() => setMethod("otp")}
            />{" "}
            Send a 6-digit code
          </label>
        </fieldset>

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send recovery message"}
        </button>
      </form>

      <p className="hint">
        Remembered it? <Link to="/login">Back to sign in</Link>.
      </p>
    </main>
  );
}
