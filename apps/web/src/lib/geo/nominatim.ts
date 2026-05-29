// Nominatim geocoding client (forward + reverse).
//
// Phase-0 uses the public OSM Nominatim instance. Its usage policy requires a
// low request rate (≤ 1 req/s) and identification. Callers MUST debounce input
// (the AddressSearch component does). In a browser the `User-Agent` header is
// forbidden and silently dropped, so identification falls back to the Referer
// the browser sends automatically. Phase-1 should point NEXT_PUBLIC_NOMINATIM_URL
// at a self-hosted instance for production traffic.

const NOMINATIM_BASE =
  process.env.NEXT_PUBLIC_NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';

// Bias suggestions to the dev OSRM region (Assam / NE-India) so picked points
// are routable. viewbox order is lon_min,lat_max,lon_max,lat_min.
const ASSAM_VIEWBOX = '89.7,27.5,96.1,24.1';

export interface NominatimSuggestion {
  label: string;
  lat: number;
  lng: number;
}

interface NominatimSearchRow {
  display_name: string;
  lat: string;
  lon: string;
}

export const MIN_QUERY_LENGTH = 3;

export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
): Promise<NominatimSuggestion[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];

  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('viewbox', ASSAM_VIEWBOX);

  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`nominatim search ${res.status}`);
  const rows = (await res.json()) as NominatimSearchRow[];
  return rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(`${NOMINATIM_BASE}/reverse`);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');

  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`nominatim reverse ${res.status}`);
  const data = (await res.json()) as { display_name?: string };
  return data.display_name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
