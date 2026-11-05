import type { rides } from '../../db/schema';

/**
 * The app-side shape of a `rides` row. Lives in its own module (re-exported by
 * `rides.repository`) so the dispatch assignment repository can lock and map a
 * ride without an import cycle back through `RidesRepository`.
 */
export interface RideRow {
  id: string;
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  fareCents: number;
  status: string;
  type: string;
  scheduledFor: Date | null;
  idempotencyKey: string;
  driverId: string | null;
  acceptedAt: Date | null;
  enRouteAt: Date | null;
  arrivedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  /** 0014: generation every offer/dispatch job for this ride must match. */
  dispatchGeneration: number;
}

export function toRow(r: typeof rides.$inferSelect): RideRow {
  return {
    id: r.id,
    passengerId: r.passengerId,
    originLat: Number(r.originLat),
    originLng: Number(r.originLng),
    destLat: Number(r.destLat),
    destLng: Number(r.destLng),
    fareCents: Number(r.fareCents),
    status: r.status,
    type: r.type,
    scheduledFor: r.scheduledFor,
    idempotencyKey: r.idempotencyKey,
    driverId: r.driverId,
    acceptedAt: r.acceptedAt,
    enRouteAt: r.enRouteAt,
    arrivedAt: r.arrivedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    cancelledBy: r.cancelledBy,
    cancelReason: r.cancelReason,
    dispatchGeneration: Number(r.dispatchGeneration),
  };
}
