import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInputShape } from "@shared/auth";
import { apiLogin } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInputShape>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      const session = await apiLogin(values);
      // Refresh the session query BEFORE navigating so the destination's
      // useSession sees the new sign-in rather than a cached "signed out".
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      // Honour a returnTo from a booking redirect, but only a relative path —
      // an absolute or protocol-relative URL would be an open redirect.
      const returnTo = searchParams.get("returnTo");
      const fallback =
        session.role === "PATIENT"
          ? "/patient"
          : session.role === "DOCTOR"
            ? "/doctor"
            : session.role === "ADMIN"
              ? "/admin"
              : "/staff";
      const target = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : fallback;
      navigate(target);
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  return (
    <main className="card">
      <h1>Sign in</h1>

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

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password !== undefined ? "password-error" : undefined}
          {...register("password")}
        />
        {errors.password?.message !== undefined && (
          <span id="password-error" className="field-error" role="alert">
            {errors.password.message}
          </span>
        )}

        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Signing in…" : "Sign in"}
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
