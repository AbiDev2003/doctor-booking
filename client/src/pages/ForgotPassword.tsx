import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { forgotPasswordSchema } from "@shared/auth";
import { apiForgotPassword, ApiError } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";

/**
 * §6.2 recovery: the response is deliberately identical for known and unknown
 * addresses (the server decides what that copy is), so this page never hints
 * either way — it echoes the server's message verbatim.
 *
 * Two delivery methods behind one form: `link` emails a URL opening the reset
 * portal directly; `otp` emails a 6-digit code that is typed below and carried
 * to the same portal as the `token` query parameter. The link lives for one
 * hour; the code lives for 60 seconds and counts down on this page. Resending
 * from here invalidates the previous code or link and restarts the clock, so
 * only the newest message works.
 */
type Request = { email: string; method: "link" | "otp" };

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
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
  const sentMethod = request?.method ?? method;

  // A one-second tick keeps the OTP countdown honest without polling a clock
  // the server owns: the TTL arrives with the response and this is display only.
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      const result = await apiForgotPassword(values);
      setSent(result.message);
      setRequest({ email: values.email, method: values.method });
      setRemaining(values.method === "otp" ? (result.codeTtlSeconds ?? 60) : 0);
      setOtp("");
      setOtpError(null);
      setResendError(null);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  async function resend() {
    if (request === null) return;
    setResending(true);
    setResendError(null);

    try {
      const result = await apiForgotPassword(request);
      setSent(result.message);
      setOtp("");
      setOtpError(null);
      setRemaining(request.method === "otp" ? (result.codeTtlSeconds ?? 60) : 0);
    } catch (err) {
      setResendError(err instanceof ApiError ? err.message : "Could not resend. Try again.");
    } finally {
      setResending(false);
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
    const expired = remaining <= 0;

    return (
      <main className="card">
        <h1>Check your email</h1>
        <p role="status">{sent}</p>

        {sentMethod === "otp" && (
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
            <button type="button" onClick={onOtpContinue} disabled={expired}>
              Continue
            </button>

            {expired ? (
              <p className="hint" role="status">
                That code has expired. Resend below for a fresh one.
              </p>
            ) : (
              <p className="hint" role="timer">
                The code expires in {remaining} second{remaining === 1 ? "" : "s"}.
              </p>
            )}
          </>
        )}

        {sentMethod === "link" && (
          <p className="hint">The link expires in 1 hour and can only be used once.</p>
        )}

        {resendError !== null && (
          <p className="form-error" role="alert">
            {resendError}
          </p>
        )}

        <button type="button" onClick={() => void resend()} disabled={resending}>
          {resending ? "Resending…" : sentMethod === "otp" ? "Resend code" : "Resend link"}
        </button>

        <p className="hint">
          Resending replaces the previous {sentMethod === "otp" ? "code and restarts the 60-second clock" : "link"} — only
          the newest message works. <Link to="/login">Back to sign in</Link>
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

        <p className="hint">
          The link expires after 1 hour; the 6-digit code expires after 60 seconds.
        </p>

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
