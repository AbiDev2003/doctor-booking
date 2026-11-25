import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { loginSchema, type LoginInputShape } from "@shared/auth"
import { PasswordInput } from "../components/password-input"
import { apiLogin } from "../lib/api"
import { applyApiErrors } from "../lib/formErrors"
import { ROLE_HOMES } from "../lib/roleHome"
import { AuthShell } from "@/components/auth/AuthShell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInputShape>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)

    try {
      const session = await apiLogin(values)
      await queryClient.invalidateQueries({ queryKey: ["me"] })
      const returnTo = searchParams.get("returnTo")
      const fallback = ROLE_HOMES[session.role]
      const target = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : fallback
      navigate(target)
    } catch (err) {
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

  return (
    <AuthShell
      title="Sign in"
      description="Access your appointments, payments, and account details."
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

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-sm font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            autoComplete="current-password"
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
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        No account yet?{" "}
        <Link to="/register" className="font-medium text-primary hover:underline">
          Create one
        </Link>
        .
      </p>
    </AuthShell>
  )
}
