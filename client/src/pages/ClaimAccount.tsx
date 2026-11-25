import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiClaimAccount } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";
import { PasswordInput } from "../components/password-input";
import {
  passwordConfirmationSchema,
  type PasswordConfirmationValues,
} from "../lib/passwordForms";
import { AuthShell } from "@/components/auth/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * §5.1 claim portal — where an invited doctor, staff member or admin sets
 * their first password. Deliberately a page of its own, not a reuse of
 * /reset-password (decision D1): the two flows share a token mechanic but
 * not a story. A reset says "you forgot"; this says "you were invited" —
 * and the token behind it has its own purpose and a one-hour lifetime
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
      <AuthShell
        title="Invitation invalid"
        description="We couldn't find a valid invitation token in this link."
      >
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription role="alert">
              This page is missing its invitation token. Open the link from your email, or ask your
              administrator to send a new invitation.
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/login">Go to sign in</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Account activated"
        description="Your account is ready to use."
      >
        <div className="space-y-4">
          <Alert className="border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertDescription>Your password is set. You can now sign in with your email address.</AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Activate your account"
      description="Set your password to get started with City Care Clinic."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="password">Choose a password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            className="bg-white"
            aria-invalid={errors.password !== undefined}
            aria-describedby={errors.password !== undefined ? "password-error" : undefined}
            {...register("password")}
          />
          {errors.password?.message !== undefined && (
            <p id="password-error" className="text-sm text-destructive" role="alert">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            className="bg-white"
            aria-invalid={errors.confirm !== undefined}
            aria-describedby={errors.confirm !== undefined ? "confirm-error" : undefined}
            {...register("confirm")}
          />
          {errors.confirm?.message !== undefined && (
            <p id="confirm-error" className="text-sm text-destructive" role="alert">
              {errors.confirm.message}
            </p>
          )}
        </div>

        {formError !== null && (
          <Alert variant="destructive">
            <AlertDescription role="alert">{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Activating…" : "Activate account"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Invitation links expire after 1 hour and work only once.
      </p>
    </AuthShell>
  );
}
