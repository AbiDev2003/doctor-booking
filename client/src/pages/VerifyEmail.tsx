import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiVerifyEmail, ApiError } from "../lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
      <AuthShell
        title="Verification failed"
        description="We couldn't verify this email link."
      >
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription role="alert">This link is missing its verification token.</AlertDescription>
          </Alert>
          <ExpiryNote />
        </div>
      </AuthShell>
    );
  }

  if (outcome === null) {
    return (
      <AuthShell
        title="Verifying your email…"
        description="Please wait while we confirm your email address."
      >
        <p className="text-sm text-slate-600" role="status">One moment.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={outcome.ok ? "Email verified" : "Verification failed"}
      description={outcome.ok ? "Your account is ready." : "We couldn't verify this email link."}
    >
      {outcome.ok ? (
        <div className="space-y-4">
          <Alert className="border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertDescription>Your email is verified. You can now book appointments.</AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/register">Back to registration</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription role="alert">{outcome.message}</AlertDescription>
          </Alert>
          <ExpiryNote />
        </div>
      )}
    </AuthShell>
  );
}

function ExpiryNote() {
  return (
    <p className="text-sm leading-6 text-slate-600">
      Verification links expire after 15 minutes and can only be used once. If yours has expired you will need a new
      link.
    </p>
  );
}
