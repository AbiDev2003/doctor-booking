import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  changeEmailSchema,
  changePhoneSchema,
  deleteAccountSchema,
  type ChangeEmailInputShape,
  type ChangePhoneInputShape,
  type DeleteAccountInputShape,
} from "@shared/account";
import {
  apiMe,
  apiLogout,
  apiChangeEmail,
  apiChangePhone,
  apiDeleteAccount,
  ApiError,
  type SessionUser,
} from "../lib/api";
import { applyApiErrors } from "../lib/formErrors";

/**
 * §6.1 account surface: identity + sign out for everyone, the three mutating
 * sections for patients. The client hides the forms from non-patients for the
 * same reason every page hides what it cannot use — but the server is what
 * enforces it (`requireRole(PATIENT)` on the router), so a hand-crafted
 * request from a doctor still gets the §7 generic 403.
 *
 * Session boot: `apiMe` carries the refresh-retry, so a page load with an
 * expired access token (or none at all) quietly resumes from the httpOnly
 * refresh cookie before this page renders anything.
 */
export default function Profile() {
  const navigate = useNavigate();

  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    apiMe(controller.signal)
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    navigate("/login");
  }, [navigate]);

  if (loading) {
    return (
      <main className="card">
        <h1>Your profile</h1>
        <p className="hint">Loading…</p>
      </main>
    );
  }

  if (user === null) {
    return (
      <main className="card">
        <h1>Your profile</h1>
        <p role="alert">You are not signed in.</p>
        <Link className="button-link" to="/login">
          Sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Your profile</h1>

      <dl className="identity">
        <div>
          <dt>Email</dt>
          <dd>{user.email ?? "—"}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{user.phone ?? "—"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{user.role}</dd>
        </div>
      </dl>

      <button type="button" className="button-secondary" onClick={() => void signOut()}>
        Sign out
      </button>

      {user.role === "PATIENT" && (
        <>
          <ChangeEmail currentEmail={user.email ?? ""} />
          <ChangePhone onPhoneChanged={(phone) => setUser({ ...user, phone })} />
          <DeleteAccount onDeleted={() => navigate("/login")} />
        </>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* §6.1(a) — change email                                              */
/* ------------------------------------------------------------------ */

function ChangeEmail({ currentEmail }: { currentEmail: string }) {
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangeEmailInputShape>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setBanner(null);

    try {
      const result = await apiChangeEmail(values);
      setBanner(result.message);
      // The address itself does NOT change until the new one is verified, so
      // the identity block keeps showing the old address on purpose —
      // verification lands on /verify-email-change and reloads the session
      // from there.
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_ALREADY_EXISTS") {
        setError("email", { type: "server", message: err.message });
        return;
      }
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  return (
    <section className="section">
      <h2>Change email</h2>
      <p className="hint">
        Currently <strong>{currentEmail}</strong>. We send a confirmation link to the new address; it becomes active
        only when you open it.
      </p>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="newEmail">New email</label>
        <input
          id="newEmail"
          type="email"
          autoComplete="email"
          aria-invalid={errors.email !== undefined}
          aria-describedby={errors.email !== undefined ? "newEmail-error" : undefined}
          {...register("email")}
        />
        {errors.email?.message !== undefined && (
          <span id="newEmail-error" className="field-error" role="alert">
            {errors.email.message}
          </span>
        )}

        {banner !== null && (
          <p className="banner banner-success" role="status">
            {banner}
          </p>
        )}
        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Sending…" : "Send confirmation link"}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §6.1(b) — change phone                                              */
/* ------------------------------------------------------------------ */

function ChangePhone({ onPhoneChanged }: { onPhoneChanged: (phone: string) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePhoneInputShape>({
    resolver: zodResolver(changePhoneSchema),
    defaultValues: { phone: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setBanner(null);

    try {
      const result = await apiChangePhone(values);
      setBanner(result.message);
      onPhoneChanged(values.phone);
      // Password is consumed by the request, not the form's state of mind —
      // clearing it keeps it out of the DOM between uses.
      reset({ phone: values.phone, password: "" });
    } catch (err) {
      if (err instanceof ApiError && (err.code === "PHONE_ALREADY_EXISTS" || err.code === "PASSWORD_INCORRECT")) {
        setError(err.code === "PHONE_ALREADY_EXISTS" ? "phone" : "password", {
          type: "server",
          message: err.message,
        });
        return;
      }
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  return (
    <section className="section">
      <h2>Change phone number</h2>
      <p className="hint">
        Confirm with your password. The number starts as unverified until our team or an SMS flow confirms it (that
        flow is a later day).
      </p>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="phone">New phone</label>
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

        <label htmlFor="currentPassword">Current password</label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password !== undefined ? "currentPassword-error" : undefined}
          {...register("password")}
        />
        {errors.password?.message !== undefined && (
          <span id="currentPassword-error" className="field-error" role="alert">
            {errors.password.message}
          </span>
        )}

        {banner !== null && (
          <p className="banner banner-success" role="status">
            {banner}
          </p>
        )}
        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Updating…" : "Update phone number"}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §6.1(c) — delete account                                            */
/* ------------------------------------------------------------------ */

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DeleteAccountInputShape>({
    resolver: zodResolver(deleteAccountSchema),
    defaultValues: { password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    if (!acknowledged) {
      setFormError("Confirm that you understand this cannot be undone.");
      return;
    }

    try {
      await apiDeleteAccount(values);
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_INCORRECT") {
        setError("password", { type: "server", message: err.message });
        return;
      }
      // §6.1 guards are things the USER has to resolve, so the server's
      // explanation is the banner — not a field-level complaint about the
      // password they typed correctly.
      setFormError(applyApiErrors(err, setError) ?? null);
    }
  });

  return (
    <section className="section">
      <h2>Delete account</h2>
      <p className="hint">
        Cancels any held seats, wipes your personal data, and signs you out everywhere. This cannot be undone.
      </p>

      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="deletePassword">Current password</label>
        <input
          id="deletePassword"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password !== undefined}
          aria-describedby={errors.password !== undefined ? "deletePassword-error" : undefined}
          {...register("password")}
        />
        {errors.password?.message !== undefined && (
          <span id="deletePassword-error" className="field-error" role="alert">
            {errors.password.message}
          </span>
        )}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => {
              setAcknowledged(e.target.checked);
              setFormError(null);
            }}
          />{" "}
          I understand this permanently deletes my account and cannot be undone.
        </label>

        {formError !== null && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" className="button-danger" disabled={isSubmitting}>
          {isSubmitting ? "Deleting…" : "Delete my account"}
        </button>
      </form>
    </section>
  );
}
