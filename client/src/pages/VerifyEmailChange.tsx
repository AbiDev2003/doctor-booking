import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiVerifyEmailChange, ApiError } from "../lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
      <AuthShell
        title="Verification failed"
        description="We couldn't verify this email change link."
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
        title="Verifying your new email…"
        description="Please wait while we confirm your new email address."
      >
        <p className="text-sm text-slate-600" role="status">One moment.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={outcome.ok ? "Email address updated" : "Verification failed"}
      description={outcome.ok ? "Your sign-in email has been changed." : "We couldn't verify this email change link."}
    >
      {outcome.ok ? (
        <div className="space-y-4">
          <Alert className="border-green-200 bg-green-50/70 text-green-950 [&>svg]:text-green-700">
            <AlertDescription>
              Your account now uses the new email address. The previous address is no longer active — use the new one
              next time you sign in.
            </AlertDescription>
          </Alert>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/login">Back to sign in</Link>
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
      Change links expire after 15 minutes and can only be used once. If yours has expired, request a new change from
      your profile.
    </p>
  );
}
