/**
 * Scripted driver simulator. Speaks the REAL driver protocol (Socket.IO `driver:location`,
 * `ride_offer` / `ride_offer_response` ack, `stop:*_confirmed`) and the REAL REST endpoints
 * (POST /v1/drivers/online, POST /v1/rides/:id/state, POST /v1/rides/:id/cancel). It is a stand-in for the
 * Flutter driver app so the web scenes have someone to answer the passenger. It has no privileged path.
 */
import { io, type Socket } from 'socket.io-client';
import { API_BASE, mintAccessToken } from './devstack';

export type OfferAction = 'accept' | 'decline' | 'ignore';

export interface Offer {
  offerId: string;
  /** solo offers */
  rideId?: string;
  /** shared offers */
  sharedRideId?: string;
  ttlMs: number;
  waveNumber: number;
  pickup?: { lat: number; lng: number };
  dropoff?: { lat: number; lng: number };
  stops?: Array<{ type: 'pickup' | 'dropoff'; lat: number; lng: number; passengerId: string; sequenceIndex: number }>;
  passengerCount?: number;
}

export interface LogEntry {
  t: number;
  kind: string;
  detail?: unknown;
}

export interface Pos {
  lat: number;
  lng: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DriverSim {
  readonly log: LogEntry[] = [];
  pos: Pos;
  private socket: Socket | null = null;
  private beat: NodeJS.Timeout | null = null;
  private heading = 90;
  private readonly token: string;
  /** Decide what to do with each incoming offer (default: accept after 1.5 s). */
  offerPolicy: (offer: Offer) => { action: OfferAction; delayMs?: number } = () => ({ action: 'accept', delayMs: 1500 });
  readonly offers: Offer[] = [];
  lastAssignment: any = null;
  /**
   * After an accepted offer, stop the presence heartbeat until the scene calls `driveTo`. The first location
   * packet after an accept makes the server start `en_route` implicitly, which would otherwise race the
   * "Driver assigned" (accepted) state past the viewer within ~2.5 s.
   */
  holdAfterAccept = true;
  private offerWaiters: Array<(o: Offer) => void> = [];

  constructor(
    readonly id: string,
    home: Pos,
  ) {
    this.pos = { ...home };
    this.token = mintAccessToken(id, 'driver', 3 * 3600);
  }

  private note(kind: string, detail?: unknown) {
    this.log.push({ t: Date.now(), kind, detail });
  }

  private async http(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* 204 / empty */
    }
    return { status: res.status, json };
  }

  /** Connect the socket, go online at the current position and start the presence heartbeat. */
  async goOnline(): Promise<void> {
    await this.connect();
    const r = await this.http('POST', '/v1/drivers/online', { lat: this.pos.lat, lng: this.pos.lng });
    if (r.status >= 300) throw new Error(`driver ${this.id} go-online failed: ${r.status} ${JSON.stringify(r.json)}`);
    this.note('online', this.pos);
    this.startHeartbeat();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = io(API_BASE, { transports: ['websocket'], auth: { token: this.token }, reconnection: true });
      this.socket = s;
      s.on('connect', () => resolve());
      s.on('connect_error', (e) => reject(e));
      s.on('driver:assignment', (a) => {
        this.lastAssignment = a?.assignment ?? null;
        this.note('assignment', a);
      });
      s.on('ride_offer_outcome', (o) => {
        if (o?.outcome === 'assigned') this.lastAssignment = o.assignment ?? null;
        this.note('offer_outcome', o);
      });
      s.on('force_offline', (o) => this.note('force_offline', o));
      s.on('ride_offer', (offer: Offer) => this.onOffer(offer));
    });
  }

  private onOffer(offer: Offer) {
    this.offers.push(offer);
    this.note('offer', offer);
    this.offerWaiters.splice(0).forEach((w) => w(offer));
    const { action, delayMs = 1200 } = this.offerPolicy(offer);
    if (action === 'ignore') return;
    setTimeout(() => {
      void this.respond(offer.offerId, action === 'accept');
    }, delayMs);
  }

  /** Resolves with the next (or already-received, if `fromStart`) offer. */
  waitForOffer(timeoutMs = 90_000): Promise<Offer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no offer within ${timeoutMs} ms`)), timeoutMs);
      this.offerWaiters.push((o) => {
        clearTimeout(timer);
        resolve(o);
      });
    });
  }

  /** Id of the trip (solo rideId or sharedRideId) the driver currently holds, once an accept has committed. */
  async tripId(timeoutMs = 10_000): Promise<string> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const a = this.lastAssignment;
      if (a) return (a.tripKind === 'shared' ? a.sharedRideId : a.rideId) as string;
      await sleep(200);
    }
    throw new Error('driver holds no assignment');
  }

  async respond(offerId: string, accept: boolean): Promise<any> {
    return new Promise((resolve) => {
      this.socket!.emit('ride_offer_response', { offerId, accept }, (ack: unknown) => {
        this.note(accept ? 'accept_ack' : 'decline_ack', ack);
        if (accept && this.holdAfterAccept && (ack as { ok?: boolean } | undefined)?.ok === true) this.stopHeartbeat();
        resolve(ack);
      });
    });
  }

  private emitLocation() {
    this.socket?.emit('driver:location', { lat: this.pos.lat, lng: this.pos.lng, heading: this.heading, speed: 7 });
  }

  startHeartbeat(everyMs = 2500): void {
    this.stopHeartbeat();
    this.emitLocation();
    this.beat = setInterval(() => this.emitLocation(), everyMs);
  }

  stopHeartbeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  /** Drive in a straight line to `to` over `seconds`, emitting a position once a second (the 1 Hz fan-out). */
  async driveTo(to: Pos, seconds: number): Promise<void> {
    this.stopHeartbeat();
    const from = { ...this.pos };
    const steps = Math.max(1, Math.round(seconds));
    this.heading = (Math.atan2(to.lng - from.lng, to.lat - from.lat) * 180) / Math.PI;
    for (let i = 1; i <= steps; i++) {
      this.pos = { lat: from.lat + ((to.lat - from.lat) * i) / steps, lng: from.lng + ((to.lng - from.lng) * i) / steps };
      this.emitLocation();
      await sleep(1000);
    }
    this.note('arrived_at_point', this.pos);
    this.startHeartbeat();
  }

  async transition(rideId: string, event: 'start_en_route' | 'mark_arrived' | 'start_ride' | 'end_ride') {
    const r = await this.http('POST', `/v1/rides/${rideId}/state`, { event });
    this.note('transition', { event, status: r.status, body: r.json });
    if (r.status >= 300) throw new Error(`transition ${event} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json as { rideId: string; status: string };
  }

  async cancel(rideId: string, reason = 'driver cancelled') {
    const r = await this.http('POST', `/v1/rides/${rideId}/cancel`, { reason });
    this.note('cancel', { status: r.status, body: r.json });
    if (r.status >= 300) throw new Error(`cancel -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }

  async markNoShow(rideId: string) {
    const r = await this.http('POST', `/v1/rides/${rideId}/cancel`, { event: 'mark_no_show' });
    this.note('no_show', { status: r.status, body: r.json });
    if (r.status >= 300) throw new Error(`no_show -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }

  /** Shared ride: confirm one stop of the pool itinerary over the socket (server-side ordering applies). */
  confirmStop(sharedRideId: string, sequenceIndex: number, type: 'pickup' | 'dropoff'): void {
    this.socket?.emit(type === 'pickup' ? 'stop:pickup_confirmed' : 'stop:drop_confirmed', {
      rideId: sharedRideId,
      sequenceIndex,
    });
    this.note('stop_confirm', { sharedRideId, sequenceIndex, type });
  }

  async stopsOf(rideId: string): Promise<Array<{ sequenceIndex: number; type: 'pickup' | 'dropoff'; lat: number; lng: number; confirmed: boolean }>> {
    const r = await this.http('GET', `/v1/rides/${rideId}/stops`);
    return r.json?.stops ?? [];
  }

  async goOffline(): Promise<void> {
    this.stopHeartbeat();
    try {
      await this.http('POST', '/v1/drivers/offline', {});
    } catch {
      /* best effort */
    }
    this.socket?.close();
    this.socket = null;
    this.note('offline');
  }
}

export { sleep };
