import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { forgotPasswordSchema } from "@shared/auth"
import { apiForgotPassword, ApiError } from "../lib/api"
import { applyApiErrors } from "../lib/formErrors"
import { AuthShell } from "@/components/auth/AuthShell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Request = { email: string; method: "link" | "otp" }

export default function ForgotPassword() {
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [request, setRequest] = useState<Request | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [resending, setResending] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)
  const [otp, setOtp] = useState("")
  const [otpError, setOtpError] = useState<string | null>(null)
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
  })
  const method = useWatch({ control, name: "method" })
  const sentMethod = request?.method ?? method

  useEffect(() => {
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [remaining])

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)

    try {
      const result = await apiForgotPassword(values)
      setSent(result.message)
      setRequest({ email: values.email, method: values.method })
      setRemaining(values.method === "otp" ? (result.codeTtlSeconds ?? 60) : 0)
      setOtp("")
      setOtpError(null)
      setResendError(null)
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

  async function resend() {
    if (request === null) return
    setResending(true)
    setResendError(null)

    try {
      const result = await apiForgotPassword(request)
      setSent(result.message)
      setOtp("")
      setOtpError(null)
      setRemaining(request.method === "otp" ? (result.codeTtlSeconds ?? 60) : 0)
    } catch (err) {
      setResendError(err instanceof ApiError ? err.message : "Could not resend. Try again.")
    } finally {
      setResending(false)
    }
  }

  function onOtpContinue() {
    if (!/^\d{6}$/.test(otp)) {
      setOtpError("Enter the 6-digit code.")
      return
    }
    setOtpError(null)
    navigate(`/reset-password?token=${encodeURIComponent(otp)}`)
  }

  if (sent !== null) {
    const expired = remaining <= 0

    return (
      <AuthShell
        title="Check your email"
        description="Follow the instructions we sent to continue recovering your account."
      >
        <div className="space-y-5">
          <Alert className="border-blue-200 bg-blue-50/70 text-slate-950 [&>svg]:text-primary">
            <AlertDescription role="status">{sent}</AlertDescription>
          </Alert>

          {sentMethod === "otp" && (
            <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="space-y-2">
                <Label htmlFor="otp">Enter your code</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otp}
                  className="bg-white"
                  aria-invalid={otpError !== null}
                  aria-describedby={otpError !== null ? "otp-error" : undefined}
                  onChange={(e) => {
                    setOtp(e.target.value)
                    setOtpError(null)
                  }}
                />
                {otpError !== null && (
                  <p id="otp-error" className="text-sm text-destructive" role="alert">
                    {otpError}
                  </p>
                )}
              </div>

              <Button type="button" onClick={onOtpContinue} disabled={expired} className="w-full sm:w-auto">
                Continue
              </Button>

              {expired ? (
                <p className="text-sm text-slate-600" role="status">
                  That code has expired. Resend below for a fresh one.
                </p>
              ) : (
                <p className="text-sm text-slate-600" role="timer">
                  The code expires in {remaining} second{remaining === 1 ? "" : "s"}.
                </p>
              )}
            </div>
          )}

          {sentMethod === "link" && (
            <p className="text-sm text-slate-600">The link expires in 1 hour and can only be used once.</p>
          )}

          {resendError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{resendError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" className="bg-white" onClick={() => void resend()} disabled={resending}>
              {resending ? "Resending…" : sentMethod === "otp" ? "Resend code" : "Resend link"}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/login">Back to sign in</Link>
            </Button>
          </div>

          <p className="text-sm text-slate-600">
            Resending replaces the previous {sentMethod === "otp" ? "code and restarts the 60-second clock" : "link"} — only the newest message works.
          </p>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Reset your password"
      description="We’ll send a reset link or a 6-digit code to your email address."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            className="bg-white"
            aria-invalid={errors.email !== undefined}
            aria-describedby={errors.email !== undefined ? "email-error" : undefined}
            {...register("email")}
          />
          {errors.email?.message !== undefined && (
            <p id="email-error" className="text-sm text-destructive" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>

        <fieldset className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
          <legend className="px-1 text-sm font-medium text-slate-900">How should we reach you?</legend>
          <label className="flex items-center gap-3 text-sm text-slate-700">
            <input type="radio" value="link" className="size-4 accent-primary" {...register("method")} />
            Send a reset link
          </label>
          <label className="flex items-center gap-3 text-sm text-slate-700">
            <input type="radio" value="otp" className="size-4 accent-primary" {...register("method")} />
            Send a 6-digit code
          </label>
        </fieldset>

        <p className="text-sm text-slate-600">
          The link expires after 1 hour; the 6-digit code expires after 60 seconds.
        </p>

        {formError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Sending…" : "Send recovery message"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Remembered it?{" "}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
        .
      </p>
    </AuthShell>
  )
}
