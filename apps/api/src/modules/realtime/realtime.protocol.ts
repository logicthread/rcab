/**
 * Realtime protocol (R09 / F10): event names, payload shapes and the version
 * rules every client applies. Dependency-free so the gateway, the snapshot
 * service, dispatch and matching can all import it without a module cycle.
 *
 * Ordering / duplicate policy
 * ---------------------------
 * - Every aggregate event carries `version`. A client keeps the highest
 *   version it has applied per aggregate and drops any incremental event whose
 *   version is not strictly greater (duplicates and reordering are no-ops).
 * - A snapshot is authoritative: it is applied when its version is >= the
 *   client's, and resets the client's view.
 * - Pool version  = `shared_rides.state_version` (trigger-bumped on every UPDATE,
 *   including the seat_count sync on a join).
 * - Solo version  = the rank of `rides.status` in the forward-only state machine
 *   (`rideStatusVersion`); terminal states share the top rank, so nothing can
 *   regress a terminal ride.
 *
 * Subscribe-versus-event race
 * ---------------------------
 * The server joins the socket to the aggregate's rooms FIRST, then reads the
 * snapshot from Postgres, then emits it. Any event committed after the join is
 * delivered; anything committed before it is inside the snapshot. Events that
 * arrive before the snapshot are superseded by it (version >=), events that
 * arrive after it with an older version are dropped.
 */

// ── client → server ──────────────────────────────────────────────────────────
/** Passenger asks to follow its pool. Ack: `SubscribeAck<PoolSnapshot>`. */
export const POOL_SUBSCRIBE = 'pool:subscribe';
/** Passenger / driver asks to follow a solo ride. Ack: `SubscribeAck<RideSnapshot>`. */
export const RIDE_SUBSCRIBE = 'ride:subscribe';
/** Driver asks for its committed assignment. Ack: `DriverAssignmentSnapshot`. */
export const DRIVER_SYNC = 'driver:sync';

// ── server → client ──────────────────────────────────────────────────────────
export const POOL_SNAPSHOT = 'pool:snapshot';
export const POOL_UPDATE = 'pool:update';
export const RIDE_SNAPSHOT = 'ride:snapshot';
export const DRIVER_ASSIGNMENT = 'driver:assignment';
/** Explicit, per-offer outcome for the driver who held the offer. */
export const RIDE_OFFER_OUTCOME = 'ride_offer_outcome';

export type SubscribeAck<T> =
  | { ok: true; snapshot: T }
  | { ok: false; reason: 'invalid_payload' | 'forbidden' | 'not_found' | 'unavailable' };

// ── solo ride ────────────────────────────────────────────────────────────────
const RIDE_STATUS_RANK: Record<string, number> = {
  requested: 1,
  dispatching: 2,
  accepted: 3,
  en_route: 4,
  arrived: 5,
  in_progress: 6,
  completed: 10,
  cancelled: 10,
  no_driver: 10,
  no_show: 10,
};

export const TERMINAL_RIDE_STATUSES: readonly string[] = [
  'completed',
  'cancelled',
  'no_driver',
  'no_show',
];

/** Monotonic version of a solo ride's status (0 for an unknown status). */
export function rideStatusVersion(status: string): number {
  return RIDE_STATUS_RANK[status] ?? 0;
}

export interface RideSnapshot {
  rideId: string;
  version: number;
  status: string;
  terminal: boolean;
  driverId: string | null;
  vehicle: VehicleView | null;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  fareCents: number;
}

// ── pool ─────────────────────────────────────────────────────────────────────
export const TERMINAL_POOL_STATES: readonly string[] = ['aborted', 'completed'];

export interface VehicleView {
  type: string;
  regNo: string;
  make: string | null;
  model: string | null;
  color: string | null;
}

/** Broadcast to `pool:<id>`: only fields every member may see. */
export interface PoolUpdatePayload {
  sharedRideId: string;
  version: number;
  seatCount: number;
  maxSeats: number;
  poolStatus: string;
  terminal: boolean;
  /** The committed claim (null until a driver is assigned). */
  driverId: string | null;
}

export function poolUpdatePayload(row: {
  rideId: string;
  stateVersion: number;
  seatCount: number;
  maxSeats: number;
  poolState: string;
  claimedByDriverId: string | null;
}): PoolUpdatePayload {
  return {
    sharedRideId: row.rideId,
    version: row.stateVersion,
    seatCount: row.seatCount,
    maxSeats: row.maxSeats,
    poolStatus: row.poolState,
    terminal: TERMINAL_POOL_STATES.includes(row.poolState),
    driverId: row.claimedByDriverId,
  };
}

/**
 * One stop of the pool itinerary as seen by ONE member: other passengers'
 * identity and coordinates are never included (R09 privacy rule).
 */
export interface MemberItineraryStop {
  sequenceIndex: number;
  type: 'pickup' | 'dropoff';
  mine: boolean;
  confirmed: boolean;
  /** Only for the caller's own stops. */
  lat?: number;
  lng?: number;
}

export interface PoolSnapshot extends PoolUpdatePayload {
  vehicle: VehicleView | null;
  completedAt: string | null;
  me: {
    active: boolean;
    quotedFareCents: number | null;
    pickup: { lat: number; lng: number };
    dropoff: { lat: number; lng: number };
  };
  itinerary: MemberItineraryStop[];
}

// ── driver ───────────────────────────────────────────────────────────────────
export interface DriverStopView {
  sequenceIndex: number;
  type: 'pickup' | 'dropoff';
  passengerId: string;
  lat: number;
  lng: number;
  confirmed: boolean;
  confirmedAt: string | null;
}

export type DriverAssignmentView =
  | {
      tripKind: 'solo';
      tripId: string;
      rideId: string;
      offerId: string | null;
      generation: number;
      assignedAt: string;
      version: number;
      status: string;
      pickup: { lat: number; lng: number };
      dropoff: { lat: number; lng: number };
      fareCents: number;
    }
  | {
      tripKind: 'shared';
      tripId: string;
      sharedRideId: string;
      offerId: string | null;
      generation: number;
      assignedAt: string;
      version: number;
      poolStatus: string;
      seatCount: number;
      stops: DriverStopView[];
    };

export interface DriverAssignmentSnapshot {
  driverId: string;
  /** null ⇒ the driver holds no active trip (Postgres guard is authoritative). */
  assignment: DriverAssignmentView | null;
}

/**
 * The explicit result of an offer for the driver who held it.
 * - `assigned`: the accept committed; `assignment` carries the trip (itinerary
 *   for shared) so the client never has to infer it from the offer.
 * - `lost`: another driver won the trip.
 * - `expired`: the offer lapsed (DB clock) or belongs to an old generation.
 * - `revoked`: the trip went away (cancelled, hard-fail, aborted pool).
 * - `rejected`: the accept was refused for a driver-side reason (busy,
 *   ineligible, vehicle capacity, itinerary missing, unknown offer).
 */
export type OfferOutcome = 'assigned' | 'lost' | 'expired' | 'revoked' | 'rejected';

export interface RideOfferOutcomePayload {
  offerId: string;
  outcome: OfferOutcome;
  tripKind?: 'solo' | 'shared';
  tripId?: string;
  generation?: number;
  reason?: string;
  assignment?: DriverAssignmentView | null;
}

/** Map an accept refusal reason to the outcome the driver UI shows. */
export function outcomeForAcceptFailure(reason: string): OfferOutcome {
  switch (reason) {
    case 'trip_taken':
      return 'lost';
    case 'offer_expired':
    case 'offer_stale':
      return 'expired';
    case 'offer_revoked':
    case 'trip_not_claimable':
      return 'revoked';
    default:
      return 'rejected';
  }
}
