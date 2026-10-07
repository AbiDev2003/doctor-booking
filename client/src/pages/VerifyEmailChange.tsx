import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { apiVerifyEmailChange, ApiError } from "../lib/api";

type Outcome = { ok: true } | { ok: false; message: string };

/**
 * §6.1 email-change confirmation: the token proves control of the NEW address,
 * so verifying it is what moves `email` — the page therefore reports the same
 * way VerifyEmail does, including the StrictMode abort discipline below.
 */
export default function VerifyEmailChange() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const missingToken = token.length === 0;

  useEffect(() => {
    if (missingToken) return;

    // StrictMode mounts, unmounts, then remounts. Change tokens are single-use,
    // so the first request must be genuinely aborted — otherwise the retry gets
    // INVALID_OR_EXPIRED_TOKEN and a user whose email DID change sees failure.
    const controller = new AbortController();

    apiVerifyEmailChange(token, controller.signal)
      .then(() => setOutcome({ ok: true }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          ok: false,
          message: err instanceof ApiError ? err.message : "Could not verify your new email. Please try again.",
        });
      });

    return () => controller.abort();
  }, [token, missingToken]);

  if (missingToken) {
    return (
      <main className="card">
        <h1>Verification failed</h1>
        <p role="alert">This link is missing its verification token.</p>
        <ExpiryNote />
      </main>
    );
  }

  if (outcome === null) {
    return (
      <main className="card">
        <h1>Verifying your new email…</h1>
        <p className="hint">One moment.</p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>{outcome.ok ? "Email address updated" : "Verification failed"}</h1>
      {outcome.ok ? (
        <>
          <p>
            Your account now uses the new email address. The previous address is no longer active — use the new one
            next time you sign in.
          </p>
          <Link className="button-link" to="/login">
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <p role="alert">{outcome.message}</p>
          <ExpiryNote />
        </>
      )}
    </main>
  );
}

function ExpiryNote() {
  return (
    <p className="hint">
      Change links expire after 15 minutes and can only be used once. If yours has expired, request a new change from
      your profile.
    </p>
  );
}
