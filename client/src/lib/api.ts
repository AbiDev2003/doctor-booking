/**
 * Single place that talks to the API, so every page unwraps the response
 * envelope the same way. Server sends either `{ data }` on success or
 * `{ error: { code, message, requestId, details? } }` on failure
 * (see server/src/middleware/errorHandler.ts).
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: init?.signal,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
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
    const error = body?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN_ERROR",
      error?.message ?? "Request failed",
      error?.requestId,
      error?.details,
    );
  }

  return body as T;
}

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