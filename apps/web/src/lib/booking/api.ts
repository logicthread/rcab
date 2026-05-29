import type { ApiRideType, CreateRideResponse, PresetTrip, QuoteResponse } from './types';

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
      const data = (await res.json()) as { code?: string; message?: string };
      code = data.code ?? code;
      message = data.message ?? message;
    } catch {
      /* fall through with defaults */
    }
    throw new BookingApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function fetchQuote(
  trip: PresetTrip,
  type: ApiRideType,
  jwt: string,
): Promise<QuoteResponse> {
  return postJson<QuoteResponse>(
    '/v1/rides/quote',
    {
      type,
      originLat: trip.originLat,
      originLng: trip.originLng,
      destLat: trip.destLat,
      destLng: trip.destLng,
    },
    jwt,
  );
}

export function createSharedRide(trip: PresetTrip, jwt: string): Promise<CreateRideResponse> {
  return postJson<CreateRideResponse>(
    '/v1/rides',
    {
      type: 'shared',
      originLat: trip.originLat,
      originLng: trip.originLng,
      destLat: trip.destLat,
      destLng: trip.destLng,
    },
    jwt,
  );
}
