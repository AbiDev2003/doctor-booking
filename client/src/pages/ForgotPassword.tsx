import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { forgotPasswordSchema } from "@shared/auth";
import { apiForgotPassword } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";

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
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<
    z.input<typeof forgotPasswordSchema>,
    unknown,
    z.output<typeof forgotPasswordSchema>
  >({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "", method: "link" },
  });
  const method = useWatch({ control, name: "method" });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      const result = await apiForgotPassword(values);
      setSent(result.message);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

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
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              aria-invalid={otpError !== null}
              aria-describedby={otpError !== null ? "otp-error" : undefined}
              onChange={(e) => {
                setOtp(e.target.value);
                setOtpError(null);
              }}
            />
            {otpError !== null && (
              <span id="otp-error" className="field-error" role="alert">
                {otpError}
              </span>
            )}
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
          type="email"
          autoComplete="email"
          aria-invalid={errors.email !== undefined}
          aria-describedby={errors.email !== undefined ? "email-error" : undefined}
          {...register("email")}
        />
        {errors.email?.message !== undefined && (
          <span id="email-error" className="field-error" role="alert">
            {errors.email.message}
          </span>
        )}

        <fieldset className="radio-row">
          <legend>How should we reach you?</legend>
          <label>
            <input type="radio" value="link" {...register("method")} /> Send a reset link
          </label>
          <label>
            <input type="radio" value="otp" {...register("method")} /> Send a 6-digit code
          </label>
        </fieldset>

        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Sending…" : "Send recovery message"}
        </button>
      </form>

      <p className="hint">
        Remembered it? <Link to="/login">Back to sign in</Link>.
      </p>
    </main>
  );
}
