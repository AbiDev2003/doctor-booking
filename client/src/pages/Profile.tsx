import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArrowLeft, LogOut, Mail, Phone, ShieldAlert, UserRound } from "lucide-react"
import {
  changeEmailSchema,
  changePhoneSchema,
  deleteAccountSchema,
  type ChangeEmailInputShape,
  type ChangePhoneInputShape,
  type DeleteAccountInputShape,
} from "@shared/account"
import {
  apiMe,
  apiLogout,
  apiChangeEmail,
  apiChangePhone,
  apiDeleteAccount,
  ApiError,
  type SessionUser,
} from "../lib/api"
import { applyApiErrors } from "../lib/formErrors"
import { ROLE_HOMES, ROLE_HOME_LABELS } from "../lib/roleHome"
import { PasswordInput } from "../components/password-input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function Profile() {
  const navigate = useNavigate()
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    apiMe(controller.signal)
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const signOut = useCallback(async () => {
    await apiLogout()
    navigate("/login")
  }, [navigate])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
          <div className="h-5 w-32 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-40 animate-pulse rounded-3xl bg-white" />
          <div className="mt-6 h-56 animate-pulse rounded-3xl bg-white" />
        </div>
      </div>
    )
  }

  if (user === null) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
          <Card className="rounded-3xl border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Your profile</CardTitle>
              <CardDescription>You are not signed in.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/login">Sign in</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-12">
        <Button asChild variant="ghost" className="-ml-3 mb-6 text-slate-600 hover:text-slate-900">
          <Link to={ROLE_HOMES[user.role]}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to {ROLE_HOME_LABELS[user.role]}
          </Link>
        </Button>

        <div className="space-y-6">
          <section className="rounded-3xl border border-blue-100 bg-gradient-to-br from-white via-white to-blue-50/60 p-6 shadow-sm sm:p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Account</p>
            <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="inline-flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-primary ring-1 ring-blue-100">
                  <UserRound className="size-7" aria-hidden="true" />
                </div>
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Your profile</h1>
                  <p className="mt-1 text-sm text-slate-600">Manage your account details and security settings.</p>
                </div>
              </div>
              <Button variant="outline" className="bg-white" onClick={() => void signOut()}>
                <LogOut className="size-4" aria-hidden="true" />
                Sign out
              </Button>
            </div>

            <dl className="mt-8 grid gap-3 sm:grid-cols-3">
              <InfoItem label="Email" value={user.email ?? "—"} />
              <InfoItem label="Phone" value={user.phone ?? "—"} />
              <InfoItem label="Role" value={user.role} />
            </dl>
          </section>

          {user.role === "PATIENT" && (
            <>
              <ChangeEmail currentEmail={user.email ?? ""} />
              <ChangePhone onPhoneChanged={(phone) => setUser({ ...user, phone })} />
              <DeleteAccount onDeleted={() => navigate("/login")} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-900">{value}</dd>
    </div>
  )
}

function ChangeEmail({ currentEmail }: { currentEmail: string }) {
  const [formError, setFormError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangeEmailInputShape>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { email: "" },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    setBanner(null)
    try {
      const result = await apiChangeEmail(values)
      setBanner(result.message)
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_ALREADY_EXISTS") {
        setError("email", { type: "server", message: err.message })
        return
      }
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="inline-flex size-10 items-center justify-center rounded-xl bg-blue-50 text-primary ring-1 ring-blue-100">
            <Mail className="size-5" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-xl text-slate-950">Change email</CardTitle>
            <CardDescription>We’ll send a confirmation link to your new email address.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-slate-600">
          Current email: <span className="font-medium text-slate-900">{currentEmail}</span>. The new address becomes active only after you verify it.
        </p>

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="newEmail">New email</Label>
            <Input
              id="newEmail"
              type="email"
              autoComplete="email"
              aria-invalid={errors.email !== undefined}
              aria-describedby={errors.email !== undefined ? "newEmail-error" : undefined}
              {...register("email")}
            />
            {errors.email?.message !== undefined && (
              <p id="newEmail-error" className="text-sm text-destructive" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>

          {banner !== null && (
            <Alert className="border-green-200 bg-green-50/70">
              <AlertTitle>Check your inbox</AlertTitle>
              <AlertDescription>{banner}</AlertDescription>
            </Alert>
          )}
          {formError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not update email</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send confirmation link"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ChangePhone({ onPhoneChanged }: { onPhoneChanged: (phone: string) => void }) {
  const [formError, setFormError] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePhoneInputShape>({
    resolver: zodResolver(changePhoneSchema),
    defaultValues: { phone: "", password: "" },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    setBanner(null)
    try {
      const result = await apiChangePhone(values)
      setBanner(result.message)
      onPhoneChanged(values.phone)
      reset({ phone: values.phone, password: "" })
    } catch (err) {
      if (err instanceof ApiError && (err.code === "PHONE_ALREADY_EXISTS" || err.code === "PASSWORD_INCORRECT")) {
        setError(err.code === "PHONE_ALREADY_EXISTS" ? "phone" : "password", {
          type: "server",
          message: err.message,
        })
        return
      }
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

  return (
    <Card className="rounded-3xl border-slate-200 shadow-sm">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="inline-flex size-10 items-center justify-center rounded-xl bg-blue-50 text-primary ring-1 ring-blue-100">
            <Phone className="size-5" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-xl text-slate-950">Change phone number</CardTitle>
            <CardDescription>Confirm with your password to update your phone number.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone">New phone</Label>
            <Input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="9876543210"
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
            <Label htmlFor="currentPassword">Current password</Label>
            <PasswordInput
              id="currentPassword"
              autoComplete="current-password"
              aria-invalid={errors.password !== undefined}
              aria-describedby={errors.password !== undefined ? "currentPassword-error" : undefined}
              {...register("password")}
            />
            {errors.password?.message !== undefined && (
              <p id="currentPassword-error" className="text-sm text-destructive" role="alert">
                {errors.password.message}
              </p>
            )}
          </div>

          {banner !== null && (
            <Alert className="border-green-200 bg-green-50/70">
              <AlertTitle>Updated</AlertTitle>
              <AlertDescription>{banner}</AlertDescription>
            </Alert>
          )}
          {formError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not update phone</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Updating…" : "Update phone number"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DeleteAccountInputShape>({
    resolver: zodResolver(deleteAccountSchema),
    defaultValues: { password: "" },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    if (!acknowledged) {
      setFormError("Confirm that you understand this cannot be undone.")
      return
    }

    try {
      await apiDeleteAccount(values)
      onDeleted()
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_INCORRECT") {
        setError("password", { type: "server", message: err.message })
        return
      }
      setFormError(applyApiErrors(err, setError) ?? null)
    }
  })

  return (
    <Card className="rounded-3xl border-red-200 shadow-sm">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="inline-flex size-10 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
            <ShieldAlert className="size-5" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-xl text-slate-950">Delete account</CardTitle>
            <CardDescription>This action is permanent and cannot be undone.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="rounded-2xl bg-red-50/70 p-4 text-sm leading-6 text-red-900 ring-1 ring-red-100">
            Deleting your account cancels held seats, wipes your personal data, and signs you out everywhere.
          </div>

          <div className="space-y-2">
            <Label htmlFor="deletePassword">Current password</Label>
            <PasswordInput
              id="deletePassword"
              autoComplete="current-password"
              aria-invalid={errors.password !== undefined}
              aria-describedby={errors.password !== undefined ? "deletePassword-error" : undefined}
              {...register("password")}
            />
            {errors.password?.message !== undefined && (
              <p id="deletePassword-error" className="text-sm text-destructive" role="alert">
                {errors.password.message}
              </p>
            )}
          </div>

          <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1 size-4 rounded border-slate-300"
              checked={acknowledged}
              onChange={(e) => {
                setAcknowledged(e.target.checked)
                setFormError(null)
              }}
            />
            <span>I understand this permanently deletes my account and cannot be undone.</span>
          </label>

          {formError !== null && (
            <Alert variant="destructive">
              <AlertTitle>Could not delete account</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" variant="destructive" disabled={isSubmitting}>
            {isSubmitting ? "Deleting…" : "Delete my account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
