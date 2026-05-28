import { Injectable, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { OsrmUnavailableException } from './osrm-unavailable.exception';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouteInput {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

type Coord = [number, number]; // [lng, lat] — OSRM GeoJSON order

interface OsrmRouteResponse {
  code: string;
  routes: Array<{ geometry: { coordinates: Coord[] } }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohash7(lat: number, lng: number): string {
  let idx = 0, bit = 0, even = true, hash = '';
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  while (hash.length < 7) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { idx = (idx << 1) | 1; lngMin = mid; }
      else { idx <<= 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = (idx << 1) | 1; latMin = mid; }
      else { idx <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

function haversineM([lng1, lat1]: Coord, [lng2, lat2]: Coord): number {
  const R = 6_371_000;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLam = ((lng2 - lng1) * Math.PI) / 180;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function resample(coords: Coord[], n: number): Coord[] {
  if (coords.length === 1) return Array<Coord>(n).fill(coords[0]);
  const dists = [0];
  for (let i = 1; i < coords.length; i++) dists.push(dists[i - 1] + haversineM(coords[i - 1], coords[i]));
  const total = dists[dists.length - 1];
  if (total === 0) return Array<Coord>(n).fill(coords[0]);
  const out: Coord[] = [];
  for (let s = 0; s < n; s++) {
    const target = (s / (n - 1)) * total;
    let seg = 0;
    while (seg < dists.length - 2 && dists[seg + 1] < target) seg++;
    const segLen = dists[seg + 1] - dists[seg];
    const t = segLen === 0 ? 0 : (target - dists[seg]) / segLen;
    out.push([
      coords[seg][0] + t * (coords[seg + 1][0] - coords[seg][0]),
      coords[seg][1] + t * (coords[seg + 1][1] - coords[seg][1]),
    ]);
  }
  return out;
}

function meanNearestNeighbour(from: Coord[], to: Coord[]): number {
  let sum = 0;
  for (const p of from) {
    let min = Infinity;
    for (const q of to) min = Math.min(min, haversineM(p, q));
    sum += min;
  }
  return sum / from.length;
}

// ── Service ───────────────────────────────────────────────────────────────────

const RESAMPLE_N = 25;

@Injectable()
export class RouteSimilarityService {
  private readonly osrmBase: string;
  private readonly saturation: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.osrmBase = config.get<string>('OSRM_BASE_URL') ?? config.get<string>('OSRM_URL') ?? 'http://osrm:5000';
    this.saturation = config.get<number>('ROUTE_SIMILARITY_SATURATION_M') ?? 1200;
  }

  async scoreRoutes(a: RouteInput, b: RouteInput): Promise<number> {
    const [p1, p2] = await Promise.all([this.getPolyline(a), this.getPolyline(b)]);
    const r1 = resample(p1, RESAMPLE_N);
    const r2 = resample(p2, RESAMPLE_N);
    const dBar = (meanNearestNeighbour(r1, r2) + meanNearestNeighbour(r2, r1)) / 2;
    return Math.max(0, 1 - dBar / this.saturation);
  }

  private async getPolyline(route: RouteInput): Promise<Coord[]> {
    const key = `osrm:poly:${geohash7(route.originLat, route.originLng)}:${geohash7(route.destLat, route.destLng)}`;
    const cached = await this.redis.get(key);
    if (cached !== null) return JSON.parse(cached) as Coord[];

    const url =
      `${this.osrmBase}/route/v1/driving/` +
      `${route.originLng},${route.originLat};${route.destLng},${route.destLat}` +
      `?overview=full&geometries=geojson`;

    let coords: Coord[];
    try {
      const { data } = await firstValueFrom(this.http.get<OsrmRouteResponse>(url));
      coords = data.routes[0].geometry.coordinates;
    } catch {
      throw new OsrmUnavailableException();
    }

    await this.redis.set(key, JSON.stringify(coords), 'EX', 3600);
    return coords;
  }
}
