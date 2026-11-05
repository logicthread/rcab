import type { SharedRideMember } from '../../db/schema';
import type { OfferStop } from '../dispatch/dispatch.types';

/**
 * Pure itinerary construction for a shared pool (moved from dispatch.service,
 * Stage C / R08). Since Stage C the itinerary is computed ONCE, inside the
 * pool-closure transaction, and persisted to `ride_stops`; dispatch and accept
 * read it from Postgres instead of recomputing or caching it in Redis.
 *
 * Deterministic for a given member set: pickups by distance from the pool
 * anchor, dropoffs nearest-neighbour from the last pickup, ties broken by
 * passenger id — never by input order.
 */
export interface ItineraryInput {
  originLat: number;
  originLng: number;
  members: SharedRideMember[];
}

export function computeStops(pool: ItineraryInput): OfferStop[] {
  const pickups = sortPickupsByDistance(pool.members, pool.originLng, pool.originLat);
  // Dropoffs follow nearest-neighbour from the last pickup: the driver heads to
  // the closest remaining destination each time instead of driving to the one
  // nearest the anchor's destination first and backtracking.
  const last = pickups[pickups.length - 1];
  const dropoffs = last
    ? orderDropoffsNearestNeighbour(pickups, last.origin_lat, last.origin_lng)
    : [];

  const stops: OfferStop[] = [];
  let seq = 0;
  for (const m of pickups) {
    stops.push({
      type: 'pickup',
      lat: m.origin_lat,
      lng: m.origin_lng,
      passengerId: m.passenger_id,
      sequenceIndex: seq++,
    });
  }
  for (const m of dropoffs) {
    stops.push({
      type: 'dropoff',
      lat: m.dest_lat,
      lng: m.dest_lng,
      passengerId: m.passenger_id,
      sequenceIndex: seq++,
    });
  }
  return stops;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLam = ((lng2 - lng1) * Math.PI) / 180;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Deterministic tie-break so equal distances never depend on input order.
function byPassengerId(a: SharedRideMember, b: SharedRideMember): number {
  return a.passenger_id < b.passenger_id ? -1 : a.passenger_id > b.passenger_id ? 1 : 0;
}

function sortPickupsByDistance(
  members: SharedRideMember[],
  refLng: number,
  refLat: number,
): SharedRideMember[] {
  return [...members].sort((a, b) => {
    const da = haversineM(refLat, refLng, a.origin_lat, a.origin_lng);
    const db = haversineM(refLat, refLng, b.origin_lat, b.origin_lng);
    return da - db || byPassengerId(a, b);
  });
}

// Greedy nearest-neighbour over the members' destinations, starting from the
// last pickup (F16 follow-up).
function orderDropoffsNearestNeighbour(
  members: SharedRideMember[],
  startLat: number,
  startLng: number,
): SharedRideMember[] {
  const remaining = [...members].sort(byPassengerId);
  const ordered: SharedRideMember[] = [];
  let curLat = startLat;
  let curLng = startLng;
  while (remaining.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineM(curLat, curLng, remaining[i].dest_lat, remaining[i].dest_lng);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    curLat = next.dest_lat;
    curLng = next.dest_lng;
  }
  return ordered;
}
