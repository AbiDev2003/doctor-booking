/**
 * Single place that talks to the API, so every page unwraps responses the same
 * way and the session plumbing lives in exactly one file.
 *
 * Session model (§6.3): the ACCESS token is a 15-minute JWT held in memory
 * here — never localStorage, because an XSS should not be able to read a
 * long-lived credential and memory dies with the tab — while the REFRESH token
 * is an opaque string in an httpOnly cookie the browser attaches on its own.
 * Every request therefore sends `credentials: "include"`, and an expired
 * access token is recovered by calling `/auth/refresh` ONCE and replaying the
 * request: the single case where a 401 is routine rather than an error.
 *
 * Success responses are the resource itself (`{ message }`,
 * `{ accessToken, ... }`, `{ user }`); failures are the error envelope
 * `{ error: { code, message, requestId, details? } }`
 * (server/src/middleware/errorHandler.ts).
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";

/**
 * The access token for the current session, or null when signed out.
 *
 * Module state rather than React state on purpose: `request` needs it from
 * inside a plain function, and a context/provider around it would make every
 * page re-render on a value that changes at most twice per session (sign-in,
 * sign-out). Pages that need to REACT to the session read it through
 * `apiMe` / `apiRestoreSession`, which is the network truth anyway — a
 * stale local flag would disagree with a server that just revoked everything.
 */
let accessToken: string | null = null;

/** In-flight refresh, so concurrent 401s share one rotation instead of racing. */
let refreshInFlight: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called by login/refresh with the new token; with null, after logout/reset. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly fields: ApiFieldError[];

  constructor(status: number, code: string, message: string, requestId?: string, details?: ApiFieldError[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fields = details ?? [];
  }

  /** Field errors keyed by name, for rendering inline under an input. */
  byField(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of this.fields) {
      if (!(field.path in out)) out[field.path] = field.message;
    }
    return out;
  }
}

/**
 * True for the 401s that mean "the access token is missing or expired", i.e.
 * the ones a refresh can fix.
 *
 * Deliberately NOT every 401: `INVALID_CREDENTIALS` (wrong password) and
 * `INVALID_REFRESH_TOKEN` (the refresh cookie is dead too) are terminal answers
 * that must reach the caller untouched — retrying them would sign a user out of
 * a failed login attempt and turn "wrong password" into a confusing network
 * retry. The server has two spellings for "no valid access token" depending on
 * whether a header arrived at all (`AUTH_REQUIRED` when absent,
 * `INVALID_ACCESS_TOKEN` when present but expired); both are recoverable here.
 */
function isRefreshable(code: string): boolean {
  return code === "INVALID_ACCESS_TOKEN" || code === "AUTH_REQUIRED";
}

/**
 * Rotates the refresh cookie into a fresh access token. Raw `fetch`, never
 * `request`: going through `request` would recurse on the same 401 that
 * spawned it.
 *
 * Concurrent callers share ONE rotation (the refresh token is single-use — two
 * parallel refreshes would have the second consuming a token the first already
 * burned, and the loser would fail a request that should have succeeded).
 * Failures clear the local token so the next call knows it is signed out.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        accessToken = null;
        return false;
      }

      const body = (await response.json().catch(() => null)) as { accessToken?: string } | null;
      if (!body?.accessToken) {
        accessToken = null;
        return false;
      }

      accessToken = body.accessToken;
      return true;
    } catch {
      // Network failure: keep whatever token we had — the server did not say
      // it is invalid, and clearing it would log the user out of a blip.
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function request<T>(path: string, init?: RequestInit, allowRefresh = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      // The refresh cookie is httpOnly and SameSite=Lax; it only travels when
      // the cross-origin request is marked credentialed, and the server's CORS
      // already answers with `credentials: true` to match.
      credentials: "include",
      headers,
    });
  } catch (err) {
    // Let aborts propagate untouched — callers use them to ignore a stale
    // response, and turning one into ApiError would surface a fake failure.
    if (init?.signal?.aborted) throw err;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Is it running?");
  }

  const body = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; requestId?: string; details?: ApiFieldError[] } }
    | null;

  if (!response.ok) {
    const code = body?.error?.code ?? "UNKNOWN_ERROR";

    // The one-shot refresh: recover the expired token and replay the original
    // request exactly once. `allowRefresh` is false on the replay, so a request
    // that STILL fails with a refreshable 401 (e.g. the refresh succeeded but
    // the account was suspended between the two calls) surfaces instead of
    // looping.
    if (response.status === 401 && allowRefresh && isRefreshable(code)) {
      if (await refreshSession()) {
        return request<T>(path, init, false);
      }
    }

    throw new ApiError(
      response.status,
      code,
      body?.error?.message ?? "Request failed",
      body?.error?.requestId,
      body?.error?.details,
    );
  }

  return body as T;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export interface SessionUser {
  id: string;
  role: "PATIENT" | "DOCTOR" | "STAFF" | "ADMIN";
  email: string | null;
  phone: string | null;
}

export interface LoginResponse {
  accessToken: string;
  userId: string;
  role: SessionUser["role"];
  emailVerified: boolean;
}

export function apiLogin(input: { email: string; password: string }): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify(input) }).then((session) => {
    accessToken = session.accessToken;
    return session;
  });
}

/**
 * Signs out: the server revokes the presented refresh token and clears the
 * cookie; the local access token goes regardless of how the request ended,
 * because "the client thinks it is signed in" is not something a failed logout
 * should be able to preserve.
 */
export async function apiLogout(): Promise<void> {
  try {
    await request("/auth/logout", { method: "POST" });
  } finally {
    accessToken = null;
  }
}

/**
 * Boots a session from the refresh cookie (page load / deep link to an
 * authenticated page). Returns null when there is nothing to resume — a normal
 * state, not an error, so callers do not need to catch it.
 */
export async function apiRestoreSession(): Promise<LoginResponse | null> {
  try {
    const session = await request<LoginResponse>("/auth/refresh", { method: "POST" });
    accessToken = session.accessToken;
    return session;
  } catch {
    accessToken = null;
    return null;
  }
}

export function apiMe(signal?: AbortSignal): Promise<{ user: SessionUser }> {
  return request("/auth/me", { signal });
}

/* ------------------------------------------------------------------ */
/* Day 7 — registration + verification                                 */
/* ------------------------------------------------------------------ */

export function apiRegister(input: {
  email: string;
  password: string;
  fullName: string;
  phone: string;
}): Promise<{ message: string }> {
  return request("/auth/register", { method: "POST", body: JSON.stringify(input) });
}

export function apiVerifyEmail(token: string, signal?: AbortSignal): Promise<{ message: string }> {
  return request(`/auth/verify-email?token=${encodeURIComponent(token)}`, { signal });
}

/* ------------------------------------------------------------------ */
/* Day 11 — password recovery (§6.2)                                   */
/* ------------------------------------------------------------------ */

/**
 * The generic §6.2 response — identical whether or not the address exists —
 * echoed back to the page rather than composed there, so the copy cannot drift
 * from the server's genericity.
 */
export function apiForgotPassword(input: { email: string; method: "link" | "otp" }): Promise<{ message: string }> {
  return request("/auth/forgot-password", { method: "POST", body: JSON.stringify(input) });
}

/**
 * Completes a reset. Clears the local access token on success: the server
 * revoked every session for the account, so anything held here is dead weight
 * that would look signed-in until its TTL ran out.
 */
export async function apiResetPassword(input: { token: string; password: string }): Promise<{ message: string }> {
  const result = await request<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify(input),
  });
  accessToken = null;
  return result;
}

/* ------------------------------------------------------------------ */
/* Day 12 — §5.1 account claim                                         */
/* ------------------------------------------------------------------ */

/**
 * The invitation link's submit. Unlike a reset, nothing here signs anyone in:
 * the server issues no session on a claim (Day 9's login remains the one
 * place tokens are minted), and no local token needs clearing — a claimable
 * account could never have had one.
 */
export function apiClaimAccount(input: { token: string; password: string }): Promise<{ message: string }> {
  return request("/auth/claim-account", { method: "POST", body: JSON.stringify(input) });
}

/* ------------------------------------------------------------------ */
/* Day 11 — account management (§6.1)                                  */
/* ------------------------------------------------------------------ */

export function apiChangeEmail(input: { email: string }): Promise<{ message: string }> {
  return request("/auth/change-email", { method: "POST", body: JSON.stringify(input) });
}

export function apiVerifyEmailChange(token: string, signal?: AbortSignal): Promise<{ message: string }> {
  return request("/auth/verify-email-change", { method: "POST", body: JSON.stringify({ token }), signal });
}

export function apiChangePhone(input: { phone: string; password: string }): Promise<{ message: string }> {
  return request("/auth/change-phone", { method: "POST", body: JSON.stringify(input) });
}

/**
 * Deletes the account (server-side: release holds → void orders → guards →
 * deactivate + anonymise, one transaction). The local token goes with it —
 * every session was revoked inside that transaction.
 */
export async function apiDeleteAccount(input: { password: string }): Promise<{ message: string }> {
  const result = await request<{ message: string }>("/auth/delete-account", {
    method: "POST",
    body: JSON.stringify(input),
  });
  accessToken = null;
  return result;
}
