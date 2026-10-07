import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  apiMe,
  apiLogout,
  apiChangeEmail,
  apiChangePhone,
  apiDeleteAccount,
  ApiError,
  type SessionUser,
} from "../lib/api";

type FieldErrors = Record<string, string>;

const EMPTY_PHONE = { phone: "", password: "" };

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
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const result = await apiChangeEmail({ email });
      setBanner(result.message);
      // The address itself does NOT change until the new one is verified, so
      // the identity block keeps showing the old address on purpose —
      // verification lands on /verify-email-change and reloads the session
      // from there.
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.code === "EMAIL_ALREADY_EXISTS") {
          setFieldErrors({ email: err.message });
        } else if (err.fields.length === 0) {
          setFormError(err.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

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
          name="newEmail"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldErrors((prev) => {
              if (!("email" in prev)) return prev;
              const next = { ...prev };
              delete next.email;
              return next;
            });
          }}
          autoComplete="email"
        />
        {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}

        {banner && (
          <p className="banner banner-success" role="status">
            {banner}
          </p>
        )}
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send confirmation link"}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §6.1(b) — change phone                                              */
/* ------------------------------------------------------------------ */

function ChangePhone({ onPhoneChanged }: { onPhoneChanged: (phone: string) => void }) {
  const [values, setValues] = useState(EMPTY_PHONE);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(name: keyof typeof EMPTY_PHONE, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const result = await apiChangePhone(values);
      setBanner(result.message);
      onPhoneChanged(values.phone);
      // Password is consumed by the request, not the form's state of mind —
      // clearing it keeps it out of the DOM between uses.
      setValues((prev) => ({ ...prev, password: "" }));
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.code === "PHONE_ALREADY_EXISTS") {
          setFieldErrors({ phone: err.message });
        } else if (err.code === "PASSWORD_INCORRECT") {
          setFieldErrors({ password: err.message });
        } else if (err.fields.length === 0) {
          setFormError(err.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

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
          name="phone"
          type="tel"
          value={values.phone}
          onChange={(e) => update("phone", e.target.value)}
          autoComplete="tel"
          placeholder="9876543210"
        />
        {fieldErrors.phone && <span className="field-error">{fieldErrors.phone}</span>}

        <label htmlFor="currentPassword">Current password</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          value={values.password}
          onChange={(e) => update("password", e.target.value)}
          autoComplete="current-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

        {banner && (
          <p className="banner banner-success" role="status">
            {banner}
          </p>
        )}
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Updating…" : "Update phone number"}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* §6.1(c) — delete account                                            */
/* ------------------------------------------------------------------ */

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (!acknowledged) {
      setFormError("Confirm that you understand this cannot be undone.");
      return;
    }

    setSubmitting(true);
    try {
      await apiDeleteAccount({ password });
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.byField());
        if (err.code === "PASSWORD_INCORRECT") {
          setFieldErrors({ password: err.message });
        } else if (
          err.code === "UPCOMING_APPOINTMENTS" ||
          err.code === "PENDING_PAYMENT" ||
          err.code === "PENDING_REFUND"
        ) {
          // §6.1 guards are things the USER has to resolve, so the server's
          // explanation is the banner — not a field-level complaint about the
          // password they typed correctly.
          setFormError(err.message);
        } else if (err.fields.length === 0) {
          setFormError(err.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

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
          name="deletePassword"
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setFieldErrors((prev) => {
              if (!("password" in prev)) return prev;
              const next = { ...prev };
              delete next.password;
              return next;
            });
          }}
          autoComplete="current-password"
        />
        {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}

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

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <button type="submit" className="button-danger" disabled={submitting}>
          {submitting ? "Deleting…" : "Delete my account"}
        </button>
      </form>
    </section>
  );
}
