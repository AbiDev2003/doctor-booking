import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { apiVerifyEmail, ApiError } from "../lib/api";

type Outcome = { ok: true } | { ok: false; message: string };

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // No token is a render-time fact, not something to fetch for — deriving it
  // here keeps the effect free of synchronous setState.
  const missingToken = token.length === 0;

  useEffect(() => {
    if (missingToken) return;

    // StrictMode mounts, unmounts, then remounts. Verification tokens are
    // single-use, so the first request must be genuinely aborted — otherwise
    // the retry gets INVALID_OR_EXPIRED_TOKEN and a verified user sees failure.
    const controller = new AbortController();

    apiVerifyEmail(token, controller.signal)
      .then(() => setOutcome({ ok: true }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setOutcome({
          ok: false,
          message: err instanceof ApiError ? err.message : "Could not verify your email. Please try again.",
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
        <h1>Verifying your email…</h1>
        <p className="hint">One moment.</p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>{outcome.ok ? "Email verified" : "Verification failed"}</h1>
      {outcome.ok ? (
        <>
          <p>Your email is verified. You can now book appointments.</p>
          <Link className="button-link" to="/register">
            Back to registration
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
      Verification links expire after 15 minutes and can only be used once. If yours has expired you will need a new
      link.
    </p>
  );
}