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

/* ------------------------------------------------------------------ */
/* Day 13 — public doctor surface (§26)                                */
/* ------------------------------------------------------------------ */

/**
 * What an anonymous visitor may know about a doctor — the client twin of the
 * server's allow-list DTO (`services/public.service.ts`). The fields absent
 * here (`licenseNumber`, `email`, `verificationStatus`, …) are absent on
 * purpose: the API never sends them to an unauthenticated caller, so a page
 * has nothing to render even if it tried.
 */
export interface PublicDoctor {
  id: string;
  fullName: string;
  qualification: string | null;
  experience: string | null;
  clinicAssociation: string | null;
  specialization: string | null;
  /** Paise, with the Clinic default applied server-side (§3.2). */
  consultationFee: number;
}

export interface PublicClinicResult {
  clinic: { name: string; timezone: string; currency: string; bookingHorizonDays: number };
  /** §26's truthful statistics, derived from real bookable doctors. */
  stats: { doctorCount: number; specializationCount: number };
}

/** One bookable window the availability read model returns (server DTO twin). */
export interface PublicAvailabilitySlot {
  slotId: string;
  /** Clinic-local `YYYY-MM-DD`. */
  slotDate: string;
  /** Clinic-local `HH:MM` wall clock. */
  startTime: string;
  endTime: string;
  /** Free seats per the stored counters — a UX hint, floored at zero. */
  remaining: number;
}

export function apiPublicDoctorAvailability(
  doctorId: string,
  date: string,
): Promise<{ availability: PublicAvailabilitySlot[] }> {
  return request(`/public/doctors/${encodeURIComponent(doctorId)}/availability?date=${encodeURIComponent(date)}`);
}

export function apiPublicClinic(): Promise<PublicClinicResult> {
  return request("/public/clinic");
}

export function apiPublicDoctors(): Promise<{ doctors: PublicDoctor[] }> {
  return request("/public/doctors");
}

export function apiPublicDoctor(id: string): Promise<{ doctor: PublicDoctor }> {
  return request(`/public/doctors/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ */
/* Day 14 — doctor dashboard (§28)                                     */
/* ------------------------------------------------------------------ */

export type DoctorVerificationStatus = "INVITED" | "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "ARCHIVED";

export interface DoctorDetail {
  id: string;
  fullName: string;
  email: string;
  verificationStatus: DoctorVerificationStatus;
  suspendedAt: string | null;
  suspendReason: string | null;
  qualification: string | null;
  licenseNumber: string | null;
  experience: string | null;
  clinicAssociation: string | null;
  specialization: string | null;
  consultationFee: number | null;
  isBookable: boolean;
  createdAt: string;
}

/**
 * The doctor's own row. The endpoint is `selfOrStaff` — this only ever answers
 * for the signed-in doctor's own id when called from the dashboard, and for a
 * staff/admin roster row otherwise; the server makes that call.
 */
export function apiGetDoctor(id: string, signal?: AbortSignal): Promise<{ doctor: DoctorDetail }> {
  return request(`/doctors/${encodeURIComponent(id)}`, { signal });
}

/**
 * Descriptive or credential edits (§5.2). The server refuses `consultationFee`
 * from a doctor (403) and forces PENDING_VERIFICATION when a credential moved;
 * the returned status is what the page shows in its re-verification banner.
 */
export function apiUpdateDoctor(
  id: string,
  patch: Partial<
    Pick<
      DoctorDetail,
      "fullName" | "qualification" | "licenseNumber" | "experience" | "clinicAssociation" | "specialization" | "consultationFee"
    >
  >,
): Promise<{ verificationStatus: DoctorVerificationStatus }> {
  return request(`/doctors/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export interface TodayQueueEntry {
  appointmentId: string;
  patientName: string;
  /** Last-four mask — the full number never leaves the server (§7/§28). */
  maskedContact: string;
  status: "CONFIRMED" | "ARRIVED" | "COMPLETED" | "NO_SHOW";
  bookingTime: string;
  upNext: boolean;
}

export interface TodaySlotQueue {
  slotId: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  queue: TodayQueueEntry[];
}

export function apiDoctorToday(): Promise<{ queue: { date: string; slots: TodaySlotQueue[] } }> {
  return request("/doctors/me/today");
}

/* ------------------------------------------------------------------ */
/* Day 19 — booking (§8.1, §15)                                        */
/* ------------------------------------------------------------------ */

export type AppointmentStatus =
  | "CONFIRMED"
  | "ARRIVED"
  | "COMPLETED"
  | "CANCELLED"
  | "REJECTED"
  | "NO_SHOW"
  | "PENDING";

/** The booking a patient just made (server twin: `schemas/appointments.ts`). */
export interface Appointment {
  id: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  slotId: string;
  /** Clinic-local `YYYY-MM-DD`. */
  slotDate: string;
  /** Clinic-local `HH:MM`. */
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  /** Paise, snapshotted at booking time. */
  feeAmount: number;
  bookingTime: string;
  createdAt: string;
}

/**
 * Books a slot for the signed-in patient (pay-at-clinic). The body is only the
 * `slotId`; the server derives the doctor, fee and status. A refusal arrives as
 * an `ApiError` with a code the page branches on (`SLOT_FULL`, `ALREADY_BOOKED`,
 * `BOOKING_CAP_REACHED`, `EMAIL_NOT_VERIFIED`, …).
 */
export function apiBookSlot(slotId: string): Promise<{ message: string; appointment: Appointment }> {
  return request("/appointments", { method: "POST", body: JSON.stringify({ slotId }) });
}

/* ------------------------------------------------------------------ */
/* Day 23 — online payment orders (§17)                                */
/* ------------------------------------------------------------------ */

/**
 * The order a Razorpay checkout opens with (server twin:
 * `schemas/payments.ts`). The AMOUNT never comes from here — the client sends
 * only a slotId and the server derives the price (§3.4) — so what this carries
 * is what the server decided: `amountPaise` in integer subunits, and `keyId`,
 * the publishable key checkout.js needs (the secret never reaches a browser).
 * By the time this response exists the server has already reserved the seat
 * (`SeatHold`, §8.6) — the checkout's job is to convert it, not to start.
 */
export interface PaymentOrder {
  orderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
}

/**
 * Creates the `PENDING` payment, the `SeatHold` behind it and the gateway
 * order — all before the checkout opens (§8.6/§17 step 1). Refusals arrive as
 * an ApiError with a code the page phrases for the patient: the shared booking
 * guards (SLOT_FULL, ALREADY_BOOKED, BOOKING_CAP_REACHED), `PAYMENTS_NOT_
 * CONFIGURED` (no keys), `ZERO_CONSULTATION_FEE`, `PAYMENT_GATEWAY_ERROR`.
 */
export function apiCreatePaymentOrder(slotId: string): Promise<{ message: string; order: PaymentOrder }> {
  return request("/payments/orders", { method: "POST", body: JSON.stringify({ slotId }) });
}

/** The gateway's post-checkout triple — passed through untouched, verified server-side (§17 step 3). */
export interface PaymentVerifyPayload {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Day 24 — posts the checkout triple; the server recomputes the signature,
 * re-checks the hold and converts it into exactly one `CONFIRMED` appointment
 * (or answers a specific refusal: HOLD_EXPIRED, ALREADY_BOOKED, …). The
 * response is the SAME `Appointment` shape `apiBookSlot` returns, so the page
 * renders one confirmation for both flows. A replay returns the stored booking
 * — convergence, not an error (§17 idempotency).
 */
export function apiVerifyPayment(payload: PaymentVerifyPayload): Promise<{ message: string; appointment: Appointment }> {
  return request("/payments/verify", { method: "POST", body: JSON.stringify(payload) });
}

/* ------------------------------------------------------------------ */
/* Day 30 — patient dashboard reads + actions (§27)                    */
/* ------------------------------------------------------------------ */

/** The patient's appointment plus the server-decided action flags (server twin). */
export interface PatientAppointment extends Appointment {
  slotStartsAt: string;
  slotEndsAt: string;
  clinicCaused: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  cancelBlockedReason: string | null;
}

export type AppointmentScope = "upcoming" | "past" | "all";

export function apiMyAppointments(
  scope: AppointmentScope = "all",
  signal?: AbortSignal,
): Promise<{ appointments: PatientAppointment[] }> {
  return request(`/appointments?scope=${encodeURIComponent(scope)}`, { signal });
}

export function apiMyAppointment(id: string, signal?: AbortSignal): Promise<{ appointment: PatientAppointment }> {
  return request(`/appointments/${encodeURIComponent(id)}`, { signal });
}

export interface CancellationPreview {
  appointmentId: string;
  canCancel: boolean;
  cancelBlockedReason: string | null;
  clinicCaused: boolean;
  slotStartsAt: string;
  cutoffAt: string | null;
  payment: {
    id: string;
    amountPaise: number;
    status: "PENDING" | "PAID" | "FAILED" | "VOIDED";
    method: "CASH" | "CARD" | "UPI" | null;
  } | null;
  refundAmountPaise: number;
  refundSettlement: "automatic" | "desk" | "none";
}

/** What cancelling would do (§17); writes nothing. */
export function apiCancellationPreview(id: string, signal?: AbortSignal): Promise<{ preview: CancellationPreview }> {
  return request(`/appointments/${encodeURIComponent(id)}/refund-preview`, { signal });
}

/** Cancels the patient's own booking; the server re-checks the cutoff and refunds (§8.5/§17). */
export function apiCancelAppointment(
  id: string,
  reason?: string,
): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(reason !== undefined && reason !== "" ? { reason } : {}),
  });
}

/** Moves the same booking to a new slot of the SAME doctor (§14). */
export function apiRescheduleAppointment(
  id: string,
  slotId: string,
  reason?: string,
): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/reschedule`, {
    method: "POST",
    body: JSON.stringify({ slotId, ...(reason !== undefined && reason !== "" && { reason }) }),
  });
}

export interface PatientRefund {
  id: string;
  kind: string;
  amountPaise: number;
  status: "PENDING" | "SUCCESS" | "FAILED";
  method: "CASH" | "CARD" | "UPI" | null;
  reason: string;
  createdAt: string;
}

export interface PatientPayment {
  id: string;
  appointmentId: string | null;
  amountPaise: number;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED" | "VOIDED";
  method: "CASH" | "CARD" | "UPI" | null;
  paidAt: string | null;
  createdAt: string;
  doctorName: string | null;
  slotDate: string | null;
  startTime: string | null;
  endTime: string | null;
  refunds: PatientRefund[];
}

export function apiMyPayments(signal?: AbortSignal): Promise<{ payments: PatientPayment[] }> {
  return request("/payments/mine", { signal });
}

/* ------------------------------------------------------------------ */
/* Day 31 — doctor dashboard: schedule + availability (§28, §11, §12)  */
/* ------------------------------------------------------------------ */

export type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

/** What a template edit's horizon top-up did (server twin: `slotGeneration.service.ts`). */
export interface MaterializeStats {
  doctors: number;
  created: number;
  skippedExistingDates: number;
  rejectedWindows: number;
}

/** One recurring weekly window (server DTO twin: `schemas/schedules.ts`). */
export interface ScheduleWindow {
  id: string;
  doctorId: string;
  weekday: Weekday;
  /** Clinic-local `HH:MM`. */
  startTime: string;
  endTime: string;
  maxPatients: number;
}

export function apiMySchedules(
  doctorId: string,
  signal?: AbortSignal,
): Promise<{ schedules: ScheduleWindow[] }> {
  return request(`/schedules?doctorId=${encodeURIComponent(doctorId)}`, { signal });
}

export interface CreateScheduleWindowInput {
  doctorId: string;
  weekday: Weekday;
  startTime: string;
  endTime: string;
  maxPatients: number;
  /** Optional on create only (§20). */
  reason?: string;
}

export interface ScheduleMutationResult {
  message: string;
  schedule: ScheduleWindow;
  materialized: MaterializeStats | null;
}

export function apiCreateScheduleWindow(input: CreateScheduleWindowInput): Promise<ScheduleMutationResult> {
  return request("/schedules", { method: "POST", body: JSON.stringify(input) });
}

/** A DOCTOR may move weekday/times but never `maxPatients` (server 403, §8.3). */
export interface UpdateScheduleWindowInput {
  weekday?: Weekday;
  startTime?: string;
  endTime?: string;
  /** Mandatory on every edit (§20). */
  reason: string;
}

export function apiUpdateScheduleWindow(
  id: string,
  patch: UpdateScheduleWindowInput,
): Promise<ScheduleMutationResult> {
  return request(`/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function apiDeleteScheduleWindow(id: string, reason: string): Promise<ScheduleMutationResult> {
  return request(`/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

/** One disruption window (server DTO twin: `schemas/unavailability.ts`). */
export interface DoctorUnavailability {
  id: string;
  doctorId: string;
  createdById: string;
  /** Clinic-local `YYYY-MM-DD` of the window's start. */
  date: string;
  startTime: string;
  endTime: string;
  startAt: string;
  endAt: string;
  reason: string;
  createdAt: string;
}

export function apiMyUnavailabilities(
  doctorId: string,
  signal?: AbortSignal,
): Promise<{ unavailabilities: DoctorUnavailability[] }> {
  return request(`/unavailabilities?doctorId=${encodeURIComponent(doctorId)}`, { signal });
}

export interface CreateUnavailabilityInput {
  doctorId: string;
  /** Clinic-local `YYYY-MM-DD`. */
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
}

export function apiCreateUnavailability(input: CreateUnavailabilityInput): Promise<{
  message: string;
  unavailability: DoctorUnavailability;
  /** CONFIRMED bookings the §12 cascade flagged. */
  affectedCount: number;
}> {
  return request("/unavailabilities", { method: "POST", body: JSON.stringify(input) });
}

export function apiRemoveUnavailability(id: string, reason: string): Promise<{ message: string }> {
  return request(`/unavailabilities/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

/* ------------------------------------------------------------------ */
/* Day 32 — staff dashboard: desk, walk-ins, history, money (§16/§29)  */
/* ------------------------------------------------------------------ */

/** The identity the desk types at the counter (server DTO twin). */
export interface DeskPatient {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  isProvisional: boolean;
}

export interface DeskPaymentSummary {
  status: "PENDING" | "PAID" | "NONE";
  outstandingPaise: number;
  paidPaise: number;
  method: "CASH" | "CARD" | "UPI" | null;
}

/** The server's answer to "which attendance verbs are open right now". */
export interface DeskAppointmentActions {
  canArrive: boolean;
  canComplete: boolean;
  canNoShow: boolean;
  canReject: boolean;
  canCancel: boolean;
  canReschedule: boolean;
  arriveBlockedReason: string | null;
  completeBlockedReason: string | null;
  noShowBlockedReason: string | null;
  cancelBlockedReason: string | null;
  rescheduleBlockedReason: string | null;
}

export interface DeskAppointment extends Appointment, DeskAppointmentActions {
  patient: DeskPatient;
  /** UTC instants, so the client can reason about "now" without the wall clock. */
  slotStartsAt: string;
  slotEndsAt: string;
  payment: DeskPaymentSummary;
}

export interface DeskSlotQueue {
  slotId: string;
  doctorId: string;
  doctorName: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  startAt: string;
  endAt: string;
  maxPatients: number;
  bookedCount: number;
  heldCount: number;
  isDisabled: boolean;
  appointments: DeskAppointment[];
}

export interface DeskQueue {
  date: string;
  slots: DeskSlotQueue[];
}

/** GET /appointments/desk — the whole clinic day, every doctor. */
export function apiDeskQueue(date?: string, signal?: AbortSignal): Promise<{ queue: DeskQueue }> {
  const query = date === undefined ? "" : `?date=${encodeURIComponent(date)}`;
  return request(`/appointments/desk${query}`, { signal });
}

export interface CreateDeskBookingInput {
  slotId: string;
  patient: {
    fullName: string;
    phone: string;
    email?: string;
  };
}

export interface DeskBookingResult {
  message: string;
  appointment: Appointment;
  patient: DeskPatient;
  createdPatient: boolean;
}

/** POST /appointments/desk — create-or-find the patient, then claim a seat. */
export function apiCreateDeskBooking(input: CreateDeskBookingInput): Promise<DeskBookingResult> {
  return request("/appointments/desk", { method: "POST", body: JSON.stringify(input) });
}

export interface PatientSummary extends DeskPatient {
  isDeactivated: boolean;
  createdAt: string;
}

export interface VisitHistory {
  found: boolean;
  patient: PatientSummary | null;
  returning: boolean;
  completedCount: number;
  noShowCount: number;
  upcomingCount: number;
  /** Clinic-local `YYYY-MM-DD` of the most recent COMPLETED visit. */
  lastVisitDate: string | null;
  doctorsSeen: string[];
  upcomingAppointments: DeskAppointment[];
}

/** GET /patients/visit-history — §16's returning-patient lookup. */
export function apiVisitHistory(phone: string, signal?: AbortSignal): Promise<{ history: VisitHistory }> {
  return request(`/patients/visit-history?phone=${encodeURIComponent(phone)}`, { signal });
}

export function apiArriveAppointment(id: string): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/arrive`, { method: "POST" });
}

export function apiCompleteAppointment(id: string): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/complete`, { method: "POST" });
}

export function apiMarkNoShow(id: string): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/no-show`, { method: "POST" });
}

export function apiRejectAppointment(id: string, reason: string): Promise<{ message: string; appointment: Appointment }> {
  return request(`/appointments/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export interface OfflinePayment {
  paymentId: string;
  appointmentId: string;
  patientId: string;
  amountPaise: number;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED" | "VOIDED";
  method: "CASH" | "CARD" | "UPI" | null;
  paidAt: string | null;
  collectedById: string | null;
  collectedAt: string | null;
}

export function apiCollectOfflinePayment(input: {
  appointmentId: string;
  method: "CASH" | "CARD" | "UPI";
  amountPaise?: number;
}): Promise<{ message: string; payment: OfflinePayment }> {
  return request("/payments/offline/collect", { method: "POST", body: JSON.stringify(input) });
}

export function apiVoidOfflinePayment(input: {
  appointmentId: string;
  reason: string;
}): Promise<{ message: string; payment: OfflinePayment }> {
  return request("/payments/offline/void", { method: "POST", body: JSON.stringify(input) });
}

export interface DeskHandBack {
  refundId: string;
  paymentId: string;
  appointmentId: string | null;
  patientId: string;
  patientName: string;
  amountPaise: number;
  kind: "RESCHEDULE_DELTA" | "CANCELLATION" | "CLINIC_CAUSED" | "EXPIRED_HOLD" | "CONVERSION_FAILED" | "DESK_HAND_BACK";
  reason: string;
  createdAt: string;
}

export function apiDeskHandBacks(signal?: AbortSignal): Promise<{ handBacks: DeskHandBack[] }> {
  return request("/payments/refunds/desk-hand-backs", { signal });
}

export function apiCompleteHandBack(
  refundId: string,
  method: "CASH" | "UPI",
): Promise<{ message: string; refund: unknown }> {
  return request(`/payments/refunds/${encodeURIComponent(refundId)}/hand-back`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });
}

/** The staff roster read; the same DTO the doctor's own profile endpoint uses. */
export function apiStaffDoctors(signal?: AbortSignal): Promise<{ doctors: DoctorDetail[] }> {
  return request("/doctors", { signal });
}

export interface Slot {
  id: string;
  doctorId: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  maxPatients: number;
  bookedCount: number;
  heldCount: number;
  isDisabled: boolean;
  disabledReason: string | null;
  startAt: string;
  endAt: string;
}

export function apiSlots(
  doctorId: string,
  slotDate?: string,
  signal?: AbortSignal,
): Promise<{ slots: Slot[] }> {
  const date = slotDate === undefined ? "" : `&slotDate=${encodeURIComponent(slotDate)}`;
  return request(`/slots?doctorId=${encodeURIComponent(doctorId)}${date}`, { signal });
}

export interface CreateSlotInput {
  doctorId: string;
  slotDate: string;
  startTime: string;
  endTime: string;
  maxPatients: number;
  reason?: string;
}

export function apiCreateSlot(input: CreateSlotInput): Promise<{ message: string; slot: Slot }> {
  return request("/slots", { method: "POST", body: JSON.stringify(input) });
}

export interface UpdateSlotInput {
  maxPatients?: number;
  slotDate?: string;
  startTime?: string;
  endTime?: string;
  reason: string;
}

export function apiUpdateSlot(id: string, input: UpdateSlotInput): Promise<{ message: string; slot: Slot }> {
  return request(`/slots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function apiSetSlotDisabled(
  id: string,
  enabled: boolean,
  reason: string,
): Promise<{ message: string; slot: Slot }> {
  return request(`/slots/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export interface CreateUnavailabilityResult {
  message: string;
  unavailability: DoctorUnavailability;
  affectedCount: number;
}

/** The staff-side alias of the doctor's own unavailability list (same route). */
export function apiDoctorUnavailabilities(
  doctorId: string,
  signal?: AbortSignal,
): Promise<{ unavailabilities: DoctorUnavailability[] }> {
  return apiMyUnavailabilities(doctorId, signal);
}

export function apiCreateDoctorUnavailability(
  input: CreateUnavailabilityInput,
): Promise<CreateUnavailabilityResult> {
  return apiCreateUnavailability(input);
}

/* ------------------------------------------------------------------ */
/* Day 33 — admin dashboard: roster, money, audit, settings            */
/* ------------------------------------------------------------------ */

export interface ClinicSettings {
  id: string
  name: string
  timezone: string
  currency: string
  defaultConsultationFee: number
  bookingHorizonDays: number
  cancelCutoffMinutes: number
  holdDurationMinutes: number
  minLeadMinutes: number
  reminderLeadMinutes: number
  maxActiveBookingsPerPatient: number
}

export function apiClinicSettings(signal?: AbortSignal): Promise<{ settings: ClinicSettings }> {
  return request("/clinics/settings", { signal })
}

export type ClinicSettingsPatch = Partial<
  Pick<
    ClinicSettings,
    | "bookingHorizonDays"
    | "cancelCutoffMinutes"
    | "holdDurationMinutes"
    | "minLeadMinutes"
    | "reminderLeadMinutes"
    | "maxActiveBookingsPerPatient"
  >
>

export function apiUpdateClinicSettings(
  patch: ClinicSettingsPatch & { reason?: string },
): Promise<{ message: string; settings: ClinicSettings }> {
  return request("/clinics/settings", { method: "PATCH", body: JSON.stringify(patch) })
}

/* ------------------------------------------------------------------ */
/* Doctor / staff lifecycle actions                                    */
/* ------------------------------------------------------------------ */

export function apiInviteDoctor(input: {
  email: string
  fullName: string
}): Promise<{ message: string; userId: string }> {
  return request("/doctors", { method: "POST", body: JSON.stringify(input) })
}

export function apiInviteStaff(input: {
  email: string
  fullName: string
}): Promise<{ message: string; userId: string }> {
  return request("/staff", { method: "POST", body: JSON.stringify(input) })
}

export function apiVerifyDoctor(id: string): Promise<{ message: string; verificationStatus: DoctorVerificationStatus }> {
  return request(`/doctors/${encodeURIComponent(id)}/verify`, { method: "POST" })
}

export function apiRejectDoctor(
  id: string,
  reason: string,
): Promise<{ message: string; verificationStatus: DoctorVerificationStatus }> {
  return request(`/doctors/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function apiUnsuspendDoctor(id: string, reason?: string): Promise<{ message: string }> {
  return request(`/doctors/${encodeURIComponent(id)}/unsuspend`, {
    method: "POST",
    body: JSON.stringify(reason !== undefined && reason !== "" ? { reason } : {}),
  })
}

export function apiUnarchiveDoctor(
  id: string,
  reason: string,
): Promise<{ message: string; verificationStatus: DoctorVerificationStatus }> {
  return request(`/doctors/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function apiSuspendDoctor(id: string, reason: string): Promise<{ message: string }> {
  return request(`/doctors/${encodeURIComponent(id)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function apiArchiveDoctor(id: string, reason: string): Promise<{ message: string }> {
  return request(`/doctors/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

/* ------------------------------------------------------------------ */
/* §20 audit read                                                      */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  id: string
  action: string
  targetType: string
  targetId: string
  before: unknown
  after: unknown
  actorId: string | null
  actorRole: SessionUser["role"] | null
  actorName: string
  reason: string | null
  ip: string | null
  requestId: string | null
  createdAt: string
}

export interface AuditPage {
  entries: AuditEntry[]
  nextCursor: string | null
}

export function apiAudit(
  input: {
    targetType?: string
    targetId?: string
    action?: string
    limit?: number
    cursor?: string
  } = {},
  signal?: AbortSignal,
): Promise<AuditPage> {
  const params = new URLSearchParams()
  if (input.targetType !== undefined && input.targetType !== "") params.set("targetType", input.targetType)
  if (input.targetId !== undefined && input.targetId !== "") params.set("targetId", input.targetId)
  if (input.action !== undefined && input.action !== "") params.set("action", input.action)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  if (input.cursor !== undefined && input.cursor !== "") params.set("cursor", input.cursor)
  const query = params.toString()
  return request(`/audit${query === "" ? "" : `?${query}`}`, { signal })
}

/* ------------------------------------------------------------------ */
/* Admin dashboard read models                                         */
/* ------------------------------------------------------------------ */

export interface AdminOverview {
  date: string
  currency: string
  appointments: {
    total: number
    confirmed: number
    arrived: number
    completed: number
    cancelled: number
    rejected: number
    noShow: number
  }
  money: { collectedPaise: number; outstandingPaise: number }
  doctors: { verified: number; pendingVerification: number; suspended: number; archived: number }
  patients: { total: number; provisional: number }
  refunds: { failed: number; pending: number }
  notifications: { failed: number; pending: number }
}

export function apiAdminOverview(signal?: AbortSignal): Promise<{ overview: AdminOverview }> {
  return request("/admin/overview", { signal })
}

export interface AdminPatient {
  id: string
  fullName: string
  phone: string
  email: string | null
  isProvisional: boolean
  isDeactivated: boolean
  createdAt: string
  completedCount: number
  noShowCount: number
  upcomingCount: number
  lastVisitDate: string | null
  returning: boolean
}

export function apiAdminPatients(
  input: { search?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ patients: AdminPatient[] }> {
  const params = new URLSearchParams()
  if (input.search !== undefined && input.search !== "") params.set("search", input.search)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return request(`/admin/patients${query === "" ? "" : `?${query}`}`, { signal })
}

export interface AdminAppointment extends Appointment {
  patientName: string
  patientPhone: string
  patientEmail: string | null
  isProvisional: boolean
  payment: DeskPaymentSummary
}

export function apiAdminAppointments(
  input: { date?: string; status?: AppointmentStatus; doctorId?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ appointments: AdminAppointment[] }> {
  const params = new URLSearchParams()
  if (input.date !== undefined && input.date !== "") params.set("date", input.date)
  if (input.status !== undefined) params.set("status", input.status)
  if (input.doctorId !== undefined && input.doctorId !== "") params.set("doctorId", input.doctorId)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return request(`/admin/appointments${query === "" ? "" : `?${query}`}`, { signal })
}

export interface AdminPaymentRefund {
  id: string
  kind: DeskHandBack["kind"]
  amountPaise: number
  status: "PENDING" | "SUCCESS" | "FAILED"
  method: "CASH" | "CARD" | "UPI" | null
  reason: string
  createdAt: string
}

export interface AdminPayment {
  id: string
  appointmentId: string | null
  patientId: string
  patientName: string
  patientPhone: string
  doctorName: string | null
  slotDate: string | null
  startTime: string | null
  endTime: string | null
  amountPaise: number
  currency: string
  status: "PENDING" | "PAID" | "FAILED" | "VOIDED"
  method: "CASH" | "CARD" | "UPI" | null
  paidAt: string | null
  createdAt: string
  collectedByName: string | null
  refunds: AdminPaymentRefund[]
}

export function apiAdminPayments(
  input: { status?: AdminPayment["status"]; method?: "CASH" | "CARD" | "UPI"; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ payments: AdminPayment[] }> {
  const params = new URLSearchParams()
  if (input.status !== undefined) params.set("status", input.status)
  if (input.method !== undefined) params.set("method", input.method)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return request(`/admin/payments${query === "" ? "" : `?${query}`}`, { signal })
}

export interface AdminRefund {
  id: string
  paymentId: string
  appointmentId: string | null
  patientId: string
  patientName: string
  amountPaise: number
  currency: string
  kind: DeskHandBack["kind"]
  status: "PENDING" | "SUCCESS" | "FAILED"
  method: "CASH" | "CARD" | "UPI" | null
  reason: string
  gatewayRefundId: string | null
  actorName: string
  createdAt: string
}

export function apiAdminRefunds(
  input: { status?: AdminRefund["status"]; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ refunds: AdminRefund[] }> {
  const params = new URLSearchParams()
  if (input.status !== undefined) params.set("status", input.status)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return request(`/admin/refunds${query === "" ? "" : `?${query}`}`, { signal })
}

export function apiRetryRefund(id: string): Promise<{ message: string; refund: unknown }> {
  return request(`/payments/refunds/${encodeURIComponent(id)}/retry`, { method: "POST" })
}

export interface AdminNotification {
  id: string
  type: string
  status: "PENDING" | "SENT" | "FAILED"
  recipient: string
  appointmentId: string | null
  error: string | null
  sentAt: string | null
  createdAt: string
}

export function apiAdminNotifications(
  input: { status?: AdminNotification["status"]; type?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ notifications: AdminNotification[] }> {
  const params = new URLSearchParams()
  if (input.status !== undefined) params.set("status", input.status)
  if (input.type !== undefined && input.type !== "") params.set("type", input.type)
  if (input.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return request(`/admin/notifications${query === "" ? "" : `?${query}`}`, { signal })
}
