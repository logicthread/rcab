import type { ApiRideType, CreateRideResponse, Place, QuoteResponse } from './types';

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

async function postJson<T>(path: string, body: unknown, jwt: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
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
