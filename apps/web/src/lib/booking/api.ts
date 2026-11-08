import type {
  ApiRideType,
  CreateRideResponse,
  Place,
  QuoteResponse,
  RideDetailResponse,
  SoloRideResponse,
} from './types';
import { useAuthStore } from '../auth/store';
import { WEB_POLICY } from '../../config/policy';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export class BookingApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BookingApiError';
  }

  /** True when the API could not route between the chosen points (OSRM). */
  get isRoutingUnavailable(): boolean {
    return this.code === 'routing_unavailable' || this.status === 503;
  }

  /** 400: the quote token behind a private booking has expired. Re-quote. */
  get isQuoteExpired(): boolean {
    return this.code === 'quote_expired';
  }

  /** 422: this Idempotency-Key was already used for a *different* request. Rotate the key. */
  get isIdempotencyConflict(): boolean {
    return this.status === 422 && this.code === 'idempotency_key_conflict';
  }

  /** 409: the original request with this key is still being processed. */
  get isIdempotencyInProgress(): boolean {
    return this.status === 409 && this.code === 'idempotency_request_in_progress';
  }

  /** 400: the key is malformed (not 1–128 visible ASCII). Rotate the key. */
  get isIdempotencyKeyInvalid(): boolean {
    return this.status === 400 && this.code === 'idempotency_key_invalid';
  }
}

interface ApiErrorBody {
  code?: string;
  message?: string;
  // The API wraps errors in an `error` envelope: { error: { code, message } }.
  error?: { code?: string; message?: string };
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as ApiErrorBody;
      code = data.error?.code ?? data.code ?? code;
      message = data.error?.message ?? data.message ?? message;
    } catch {
      /* fall through with defaults */
    }
    throw new BookingApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/**
 * Authenticated fetch: takes a (refreshed-if-needed) access token from the auth
 * store, and on a 401 retries exactly once with a token from the single-flight
 * refresh shared by every concurrent caller. A 401 means the request was not
 * processed, so replaying it (same Idempotency-Key) is safe.
 */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = useAuthStore.getState();
  const token = await auth.getAccessToken();
  if (!token) throw new BookingApiError(401, 'unauthenticated', 'Not signed in');
  const send = (t: string) =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` },
    });
  const res = await send(token);
  if (res.status !== 401) return res;
  const fresh = await useAuthStore.getState().refreshAccessToken();
  if (!fresh) return res;
  return send(fresh);
}

async function postJson<T>(
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal,
  });
  return parseOrThrow<T>(res);
}

/** Pause before the single replay of a request the server reports as still in progress. */
export const IDEMPOTENCY_IN_PROGRESS_RETRY_MS = WEB_POLICY.booking.idempotencyInProgressRetryMs;

/**
 * POST a create with an `Idempotency-Key`. A 409 `idempotency_request_in_progress`
 * means the first attempt with this key is still running (e.g. a double submit or
 * a retry racing a slow response): wait briefly and replay the SAME request with
 * the SAME key exactly once — the server then returns the original result. A
 * second 409 is surfaced to the caller. 422 / 400 are not retried here: they need
 * a new key, which only the caller (which owns the key) can mint.
 */
async function postIdempotent<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const headers = { 'Idempotency-Key': idempotencyKey };
  try {
    return await postJson<T>(path, body, headers);
  } catch (err) {
    if (!(err instanceof BookingApiError) || !err.isIdempotencyInProgress) throw err;
    await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_IN_PROGRESS_RETRY_MS));
    return postJson<T>(path, body, headers);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  return parseOrThrow<T>(res);
}

function routeBody(pickup: Place, dropoff: Place, type: ApiRideType) {
  return {
    type,
    originLat: pickup.lat,
    originLng: pickup.lng,
    destLat: dropoff.lat,
    destLng: dropoff.lng,
  };
}

export function fetchQuote(
  pickup: Place,
  dropoff: Place,
  type: ApiRideType,
  signal?: AbortSignal,
): Promise<QuoteResponse> {
  return postJson<QuoteResponse>('/v1/rides/quote', routeBody(pickup, dropoff, type), {}, signal);
}

export function createSharedRide(
  pickup: Place,
  dropoff: Place,
  idempotencyKey: string,
): Promise<CreateRideResponse> {
  return postIdempotent<CreateRideResponse>(
    '/v1/rides',
    routeBody(pickup, dropoff, 'shared'),
    idempotencyKey,
  );
}

/**
 * Create a solo (normal) ride. The signed `quoteToken` from /quote locks the
 * fare + route; the `Idempotency-Key` makes a retried submit return the same
 * ride instead of double-booking (RCAB-E4.S2 contract).
 */
export function createNormalRide(
  pickup: Place,
  dropoff: Place,
  quoteToken: string,
  idempotencyKey: string,
): Promise<SoloRideResponse> {
  return postIdempotent<SoloRideResponse>(
    '/v1/rides',
    { ...routeBody(pickup, dropoff, 'normal'), quoteToken },
    idempotencyKey,
  );
}

/** Fetch a ride's current state — used to rehydrate the tracking view on reload. */
export function fetchRide(rideId: string): Promise<RideDetailResponse> {
  return getJson<RideDetailResponse>(`/v1/rides/${rideId}`);
}

export interface CancelRideResponse {
  rideId: string;
  status: string;
  cancelledBy: string | null;
}

/**
 * Cancel the active ride (client side). No idempotency key — cancel is naturally
 * idempotent on a terminal row, and a re-cancel just returns a 409 the UI
 * ignores (the ride is already terminal). RCAB-E4.S8.
 */
export function cancelRide(rideId: string): Promise<CancelRideResponse> {
  return postJson<CancelRideResponse>(`/v1/rides/${rideId}/cancel`, {});
}

export interface RatingResponse {
  id: string;
  rideId: string;
  subjectId: string;
  stars: number;
}

/**
 * Submit a 1–5 star rating (+ optional text) for the other party of a completed
 * ride. The direction (who is rated) is inferred from auth server-side. The
 * caller swallows a 409 (`already_rated`) — re-rating a ride is benign.
 * RCAB-E4.S9.
 */
export function submitRating(
  rideId: string,
  stars: number,
  text: string | undefined,
): Promise<RatingResponse> {
  const trimmed = text?.trim();
  return postJson<RatingResponse>(`/v1/rides/${rideId}/ratings`, {
    stars,
    ...(trimmed ? { text: trimmed } : {}),
  });
}
