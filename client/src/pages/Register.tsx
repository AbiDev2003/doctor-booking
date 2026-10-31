import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { registerSchema, type RegisterInput } from "@shared/auth";
import { apiRegister } from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";

export default function Register() {
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", email: "", phone: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      await apiRegister(values);
      setDone(true);
    } catch (err) {
      // EMAIL/PHONE_ALREADY_EXISTS land on the field that caused them.
      const message = applyApiErrors(err, setError);
      setFormError(message ?? null);
    }
  });

  if (done) {
    return (
      <main className="card">
        <h1>Check your email</h1>
        <p>
          We sent a verification link to <strong>{getValues("email")}</strong>. Open it to activate your account.
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
          autoComplete="name"
          aria-invalid={errors.fullName !== undefined}
          aria-describedby={errors.fullName !== undefined ? "fullName-error" : undefined}
          {...register("fullName")}
        />
        {errors.fullName?.message !== undefined && (
          <span id="fullName-error" className="field-error" role="alert">
            {errors.fullName.message}
          </span>
        )}

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

        <label htmlFor="phone">Phone</label>
        <input
          id="phone"
          type="tel"
          autoComplete="tel"
          placeholder="9876543210"
          aria-invalid={errors.phone !== undefined}
          aria-describedby={errors.phone !== undefined ? "phone-error" : undefined}
          {...register("phone")}
        />
        {errors.phone?.message !== undefined && (
          <span id="phone-error" className="field-error" role="alert">
            {errors.phone.message}
          </span>
        )}

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
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
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
