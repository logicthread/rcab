/**
 * Fixture users for the web demo scenes. Rows are tagged `firebase_uid LIKE 'webrec-%'` so `cleanDemoFixtures`
 * removes exactly them. Ids (…0000007400NN clients, …0000007500NN drivers, …0000007600NN vehicles) are disjoint from scripts/seed-dev.sh and infra/load/prepare-dev.mjs (…5xxx).
 * and from the other recording harnesses (…7000NN, …7100NN).
 */
import { psql, redis } from './devstack';

const pad = (n: number) => String(n).padStart(2, '0');
export const clientId = (n: number) => `00000000-0000-4000-8000-0000007400${pad(n)}`;
export const driverId = (n: number) => `00000000-0000-4000-8000-0000007500${pad(n)}`;
export const vehicleId = (n: number) => `00000000-0000-4000-8000-0000007600${pad(n)}`;

/** Guwahati AREA A (this agent's zone). Other recording agents use areas >= 2*R2 (8 km) away. */
export const AREA_A = { lat: 26.1445, lng: 91.7362 };

export interface Person {
  n: number;
  id: string;
  phone: string;
  name: string;
}

export function ensureClient(n: number, name = `Demo Rider ${n}`): Person {
  const id = clientId(n);
  const phone = `+9198340000${pad(n)}`;
  psql(`
    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES ('${id}', 'webrec-client-${n}', '${phone}', '${name}', 'client', 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active', display_name = EXCLUDED.display_name;
    INSERT INTO client (user_id) VALUES ('${id}') ON CONFLICT (user_id) DO NOTHING;
  `);
  releaseClient(n);
  return { n, id, phone, name };
}

export function ensureDriver(n: number, name = `Demo Driver ${n}`): Person {
  const id = driverId(n);
  const vid = vehicleId(n);
  const phone = `+9198350000${pad(n)}`;
  psql(`
    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES ('${id}', 'webrec-driver-${n}', '${phone}', '${name}', 'driver', 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active', display_name = EXCLUDED.display_name;
    INSERT INTO driver (user_id, license_no, verified_at, availability)
    VALUES ('${id}', 'DEMOWEB${pad(n)}', now(), 'offline')
    ON CONFLICT (user_id) DO UPDATE SET verified_at = now(), availability = 'offline';
    INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active)
    VALUES ('${vid}', '${id}', 'cab_sedan', 'AS01DW${pad(n)}', 'Maruti', 'Dzire', 'white', 4, true)
    ON CONFLICT (id) DO UPDATE SET active = true;
    UPDATE driver SET current_vehicle_id = '${vid}' WHERE user_id = '${id}';
  `);
  psql(`DELETE FROM driver_active_assignment WHERE driver_id = '${id}';`);
  redis('ZREM', 'active_drivers', id);
  redis('DEL', `driver:state:${id}`);
  return { n, id, phone, name };
}

/** Cancel whatever a fixture client still has live (pools included) so the next scene starts clean. */
export function releaseClient(n: number): void {
  const id = clientId(n);
  // Leave nothing active from an earlier run (a second active ride would 409 the create). The rides are cancelled
  // with SQL, so the driver's assignment guard (driver_active_assignment) must be freed here too, otherwise the
  // driver stays "busy" with a cancelled ride and never receives another offer.
  psql(`
    DELETE FROM driver_active_assignment
     WHERE solo_ride_id IN (SELECT id FROM rides WHERE passenger_id = '${id}' AND status IN ('requested','dispatching','accepted','en_route','arrived','in_progress'))
        OR shared_ride_id IN (SELECT pool_id FROM pool_member WHERE passenger_id = '${id}');
    DELETE FROM shared_rides WHERE ride_id IN (SELECT pool_id FROM pool_member WHERE passenger_id = '${id}');
    UPDATE rides SET status = 'cancelled', cancelled_by = 'client', cancel_reason = 'webrec-reset'
     WHERE passenger_id = '${id}' AND status IN ('requested','dispatching','accepted','en_route','arrived','in_progress');
  `);
}

/** Take a fixture driver fully offline (presence + DB). */
export function releaseDriver(n: number): void {
  const id = driverId(n);
  redis('ZREM', 'active_drivers', id);
  redis('DEL', `driver:state:${id}`);
  psql(`UPDATE driver SET availability = 'offline' WHERE user_id = '${id}';`);
}

/**
 * Harness-only time travel for the no-show scene: the driver may report a no-show only 5 minutes
 * (policy rides.noShowWaitMs) after `arrived`. Rather than recording a 5-minute wait, back-date arrived_at.
 */
export function backdateArrival(rideId: string, minutes: number): void {
  psql(`UPDATE rides SET arrived_at = now() - interval '${minutes} minutes' WHERE id = '${rideId}' AND status = 'arrived';`);
}

export function rideStatus(rideId: string): string {
  return psql(`SELECT status FROM rides WHERE id = '${rideId}';`).trim();
}

/** Remove every demo-web fixture (users, rides, ratings, pool rows, presence). */
export function cleanDemoFixtures(): void {
  const q = `(SELECT id FROM app_user WHERE firebase_uid LIKE 'webrec-%')`;
  psql(`
    DELETE FROM ratings WHERE rater_id IN ${q} OR subject_id IN ${q};
    DELETE FROM rides WHERE passenger_id IN ${q};
    DELETE FROM shared_rides WHERE ride_id IN (SELECT pool_id FROM pool_member WHERE passenger_id IN ${q});
    DELETE FROM pool_member WHERE passenger_id IN ${q};
    UPDATE driver SET current_vehicle_id = NULL WHERE user_id IN ${q};
    DELETE FROM vehicle WHERE driver_id IN ${q};
    DELETE FROM app_user WHERE firebase_uid LIKE 'webrec-%';
  `);
  for (let n = 1; n <= 99; n++) {
    redis('ZREM', 'active_drivers', driverId(n));
    redis('DEL', `driver:state:${driverId(n)}`);
  }
}
