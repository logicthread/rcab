import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';

export interface Eta {
  distanceM: number;
  durationS: number;
}

interface LatLng {
  lat: number;
  lng: number;
}

/** One OSRM call per wave must never hold offers back: fall back to an estimate. */
const OSRM_TIMEOUT_MS = 1500;
/** Fallback road estimate: straight line × detour factor at an urban speed. */
const ROAD_FACTOR = 1.4;
const FALLBACK_SPEED_MPS = 8; // ~29 km/h

/**
 * Distance and travel time from a driver's CURRENT position (the `active_drivers`
 * geo index) to a point: what the driver's offer screen shows, and what decides
 * whether a driver still on a ride is close enough to its end to take the next
 * one. Road figures come from OSRM (`/table`, one request for many drivers); when
 * OSRM is slow or down it degrades to a straight-line estimate instead of
 * failing, since a slightly-off ETA must never block dispatch.
 */
@Injectable()
export class DriverEtaService {
  private readonly log = new Logger(DriverEtaService.name);
  private readonly osrmBase: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.osrmBase = config.get<string>('OSRM_BASE_URL') ?? config.get<string>('OSRM_URL') ?? 'http://osrm:5000';
  }

  /** Last known position of each driver (drivers absent from the geo index are omitted). */
  async positions(driverIds: string[]): Promise<Map<string, LatLng>> {
    const out = new Map<string, LatLng>();
    if (driverIds.length === 0) return out;
    const res = (await this.redis.geopos('active_drivers', ...driverIds)) as Array<[string, string] | null>;
    res.forEach((p, i) => {
      if (p) out.set(driverIds[i], { lng: Number(p[0]), lat: Number(p[1]) });
    });
    return out;
  }

  /** ETA from each driver's current position to `point`. Drivers with no known position are omitted. */
  async toPoint(driverIds: string[], point: LatLng): Promise<Map<string, Eta>> {
    const pos = await this.positions(driverIds);
    const ids = [...pos.keys()];
    const out = new Map<string, Eta>();
    if (ids.length === 0) return out;
    const road = await this.osrmTable(
      ids.map((id) => pos.get(id) as LatLng),
      point,
    );
    ids.forEach((id, i) => {
      out.set(id, road?.[i] ?? estimate(pos.get(id) as LatLng, point));
    });
    return out;
  }

  /** ETA of one driver to `point`, or null when their position is unknown. */
  async one(driverId: string, point: LatLng): Promise<Eta | null> {
    return (await this.toPoint([driverId], point)).get(driverId) ?? null;
  }

  private async osrmTable(sources: LatLng[], dest: LatLng): Promise<Eta[] | null> {
    try {
      const coords = [dest, ...sources].map((p) => `${p.lng},${p.lat}`).join(';');
      const idx = sources.map((_, i) => i + 1).join(';');
      const url =
        `${this.osrmBase}/table/v1/driving/${coords}` +
        `?sources=${idx}&destinations=0&annotations=duration,distance`;
      const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        code?: string;
        durations?: Array<Array<number | null>>;
        distances?: Array<Array<number | null>>;
      };
      if (data.code !== 'Ok' || !data.durations || !data.distances) return null;
      const out: Eta[] = [];
      for (let i = 0; i < sources.length; i++) {
        const d = data.durations[i]?.[0];
        const m = data.distances[i]?.[0];
        if (typeof d !== 'number' || typeof m !== 'number') {
          out.push(estimate(sources[i], dest));
        } else {
          out.push({ distanceM: Math.round(m), durationS: Math.round(d) });
        }
      }
      return out;
    } catch (err) {
      this.log.debug({ err }, 'OSRM table unavailable; using straight-line ETA');
      return null;
    }
  }
}

function haversineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function estimate(a: LatLng, b: LatLng): Eta {
  const distanceM = Math.round(haversineM(a, b) * ROAD_FACTOR);
  return { distanceM, durationS: Math.round(distanceM / FALLBACK_SPEED_MPS) };
}
