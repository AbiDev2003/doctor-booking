import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PasswordInput } from "../components/password-input";
import { apiResetPassword } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";
import {
  passwordConfirmationSchema,
  type PasswordConfirmationValues,
} from "../lib/passwordForms";
import { AuthShell } from "@/components/auth/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

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
      await apiResetPassword({ token, password: values.password });
      setDone(true);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  if (missingToken) {
    return (
      <AuthShell
        title="Reset failed"
        description="We couldn't find a valid recovery token in this link."
      >
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription role="alert">
              This page is missing its recovery token. Open the link from your email, or request a new code.
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/forgot-password">Request a new link or code</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        description="Your account is secure and ready to use."
      >
        <div className="space-y-4">
          <Alert className="border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertDescription>
              Your password has been changed and every other session was signed out.
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/login">Sign in with your new password</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      description="Create a new password for your account."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
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
          <Label htmlFor="confirm">Confirm new password</Label>
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
          {isSubmitting ? "Updating…" : "Update password"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Codes and links expire after 15 minutes and work only once.
      </p>
    </AuthShell>
  );
}
