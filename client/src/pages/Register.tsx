import { useState } from "react"
import { Link } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { registerSchema, type RegisterInput } from "@shared/auth"
import { PasswordInput } from "../components/password-input"
import { apiRegister } from "../lib/api"
import { applyApiErrors } from "../lib/formErrors"
import { AuthShell } from "@/components/auth/AuthShell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function Register() {
  const [done, setDone] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: "", email: "", phone: "", password: "" },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)

    try {
      await apiRegister(values)
      setDone(true)
    } catch (err) {
      const message = applyApiErrors(err, setError)
      setFormError(message ?? null)
    }
  })

  if (done) {
    return (
      <AuthShell
        title="Check your email"
        description="We’ve sent you a verification link to activate your account."
      >
        <div className="space-y-4">
          <Alert className="border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertDescription>
              We sent a verification link to <strong>{getValues("email")}</strong>. Open it to activate your account.
            </AlertDescription>
          </Alert>
          <p className="text-sm leading-6 text-slate-600">
            The link expires in 15 minutes. Until you verify, you won&apos;t be able to book an appointment.
          </p>
          <Button asChild variant="outline" className="bg-white">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Create your account"
      description="Register to book appointments and manage your care."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="fullName">Full name</Label>
          <Input
            id="fullName"
            autoComplete="name"
            className="bg-white"
            aria-invalid={errors.fullName !== undefined}
            aria-describedby={errors.fullName !== undefined ? "fullName-error" : undefined}
            {...register("fullName")}
          />
          {errors.fullName?.message !== undefined && (
            <p id="fullName-error" className="text-sm text-destructive" role="alert">
              {errors.fullName.message}
            </p>
          )}
        </div>

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

        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            type="tel"
            autoComplete="tel"
            placeholder="9876543210"
            className="bg-white"
            aria-invalid={errors.phone !== undefined}
            aria-describedby={errors.phone !== undefined ? "phone-error" : undefined}
            {...register("phone")}
          />
          {errors.phone?.message !== undefined && (
            <p id="phone-error" className="text-sm text-destructive" role="alert">
              {errors.phone.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
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

        {formError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
        .
      </p>
    </AuthShell>
  )
}
