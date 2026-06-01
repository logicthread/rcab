import type {
  ApiRideType,
  CreateRideResponse,
  Place,
  QuoteResponse,
  RideDetailResponse,
  SoloRideResponse,
} from './types';

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

async function postJson<T>(
  path: string,
  body: unknown,
  jwt: string,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return parseOrThrow<T>(res);
}

async function getJson<T>(path: string, jwt: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
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
  jwt: string,
): Promise<QuoteResponse> {
  return postJson<QuoteResponse>('/v1/rides/quote', routeBody(pickup, dropoff, type), jwt);
}

export function createSharedRide(
  pickup: Place,
  dropoff: Place,
  jwt: string,
): Promise<CreateRideResponse> {
  return postJson<CreateRideResponse>('/v1/rides', routeBody(pickup, dropoff, 'shared'), jwt);
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
  jwt: string,
  idempotencyKey: string,
): Promise<SoloRideResponse> {
  return postJson<SoloRideResponse>(
    '/v1/rides',
    { ...routeBody(pickup, dropoff, 'normal'), quoteToken },
    jwt,
    { 'Idempotency-Key': idempotencyKey },
  );
}

/** Fetch a ride's current state — used to rehydrate the tracking view on reload. */
export function fetchRide(rideId: string, jwt: string): Promise<RideDetailResponse> {
  return getJson<RideDetailResponse>(`/v1/rides/${rideId}`, jwt);
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
export function cancelRide(rideId: string, jwt: string): Promise<CancelRideResponse> {
  return postJson<CancelRideResponse>(`/v1/rides/${rideId}/cancel`, {}, jwt);
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
  jwt: string,
): Promise<RatingResponse> {
  const trimmed = text?.trim();
  return postJson<RatingResponse>(
    `/v1/rides/${rideId}/ratings`,
    { stars, ...(trimmed ? { text: trimmed } : {}) },
    jwt,
  );
}
