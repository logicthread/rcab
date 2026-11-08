-- Small, deterministic fixture for the recovery drills (RCAB-E8.S3).
-- Applied AFTER all migrations, on a DISPOSABLE database only. Never run on dev/prod data.
--
-- Shapes it creates (ids start fa00...):
--   drivers   D1 (assigned to ride E), D2 (free)
--   ride A    solo, status requested, dispatch generation 1, intent already published (outbox processed)
--             -> after a Redis loss, the reconciler must re-arm dispatch
--   ride B    scheduled, requested, generation 0, wake already published
--             -> reconciler must re-publish the delayed wake job
--   pool P    open, 1 member, expiry timer already published
--             -> reconciler must restore pool-expire-<P>; pool:<P> hash is rebuilt at boot
--   ride E    solo, accepted by D1 with its driver_active_assignment guard
--             -> driver:state:<D1>.current_ride_id must be re-projected once D1 is present
-- All "old" rows are backdated 10 minutes so the reconciler's 15 s grace window is irrelevant.

BEGIN;

INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status) VALUES
  ('fa000000-0000-4000-8000-000000000d01', 'drill-driver-1', '+919800000001', 'Drill Driver 1', 'driver', 'active'),
  ('fa000000-0000-4000-8000-000000000d02', 'drill-driver-2', '+919800000002', 'Drill Driver 2', 'driver', 'active'),
  ('fa000000-0000-4000-8000-000000000c01', 'drill-client-1', '+919800000011', 'Drill Client 1', 'client', 'active'),
  ('fa000000-0000-4000-8000-000000000c02', 'drill-client-2', '+919800000012', 'Drill Client 2', 'client', 'active'),
  ('fa000000-0000-4000-8000-000000000c03', 'drill-client-3', '+919800000013', 'Drill Client 3', 'client', 'active'),
  ('fa000000-0000-4000-8000-000000000c04', 'drill-client-4', '+919800000014', 'Drill Client 4', 'client', 'active');

INSERT INTO client (user_id)
SELECT id FROM app_user WHERE role = 'client' AND firebase_uid LIKE 'drill-client-%';

INSERT INTO driver (user_id, license_no, verified_at, availability) VALUES
  ('fa000000-0000-4000-8000-000000000d01', 'DRILLLIC0001', now(), 'offline'),
  ('fa000000-0000-4000-8000-000000000d02', 'DRILLLIC0002', now(), 'offline');

INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active) VALUES
  ('fa000000-0000-4000-8000-0000000002a1', 'fa000000-0000-4000-8000-000000000d01', 'cab_sedan', 'DRILL0001', 'Drill', 'Fixture', 'white', 4, true),
  ('fa000000-0000-4000-8000-0000000002a2', 'fa000000-0000-4000-8000-000000000d02', 'cab_sedan', 'DRILL0002', 'Drill', 'Fixture', 'white', 4, true);
UPDATE driver SET current_vehicle_id = 'fa000000-0000-4000-8000-0000000002a1' WHERE user_id = 'fa000000-0000-4000-8000-000000000d01';
UPDATE driver SET current_vehicle_id = 'fa000000-0000-4000-8000-0000000002a2' WHERE user_id = 'fa000000-0000-4000-8000-000000000d02';

-- ride A: normal solo, dispatching on generation 1
INSERT INTO rides (id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, fare_cents, status, type,
                   idempotency_key, idempotency_operation, dispatch_generation, created_at, updated_at)
VALUES ('fa000000-0000-4000-8000-00000000000a', 'fa000000-0000-4000-8000-000000000c01',
        26.1445, 91.7362, 26.1745, 91.7862, 18500, 'requested', 'normal',
        'drill-idem-a', 'ride.create.solo', 1, now() - interval '10 minutes', now() - interval '10 minutes');
INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key, processed_at, created_at)
VALUES ('ride.dispatch.requested', 'ride', 'fa000000-0000-4000-8000-00000000000a', 1,
        '{"rideId":"fa000000-0000-4000-8000-00000000000a"}', 'ride.dispatch.requested:fa..0a:g1',
        now() - interval '10 minutes', now() - interval '10 minutes');

-- ride B: scheduled two hours out, not yet woken
INSERT INTO rides (id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, fare_cents, status, type,
                   scheduled_for, idempotency_key, idempotency_operation, dispatch_generation, created_at, updated_at)
VALUES ('fa000000-0000-4000-8000-00000000000b', 'fa000000-0000-4000-8000-000000000c02',
        26.1445, 91.7362, 26.1745, 91.7862, 21000, 'requested', 'scheduled',
        now() + interval '2 hours', 'drill-idem-b', 'ride.create.scheduled', 0,
        now() - interval '10 minutes', now() - interval '10 minutes');
INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key, processed_at, created_at)
VALUES ('ride.wake.schedule', 'ride', 'fa000000-0000-4000-8000-00000000000b', 1,
        jsonb_build_object('scheduledFor', to_jsonb(now() + interval '2 hours')),
        'ride.wake.schedule:fa..0b:g1', now() - interval '10 minutes', now() - interval '10 minutes');

-- pool P: open, one member
INSERT INTO shared_rides (ride_id, max_seats, pool_state, origin_lat, origin_lng, dest_lat, dest_lng, members,
                          created_at, updated_at)
VALUES ('fa000000-0000-4000-8000-00000000000f', 4, 'open', 26.1445, 91.7362, 26.1519, 91.7423, '[]'::jsonb,
        now() - interval '10 minutes', now() - interval '10 minutes');
INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, agreed_fare_cents)
VALUES ('fa000000-0000-4000-8000-00000000000f', 'fa000000-0000-4000-8000-000000000c03',
        26.1445, 91.7362, 26.1519, 91.7423, 6000);
UPDATE shared_rides SET updated_at = now() - interval '10 minutes'
 WHERE ride_id = 'fa000000-0000-4000-8000-00000000000f';
INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key, processed_at, created_at)
VALUES ('pool.expire.schedule', 'shared_ride', 'fa000000-0000-4000-8000-00000000000f', 0,
        jsonb_build_object('expireAt', to_jsonb(now() + interval '1 minute')),
        'pool.expire.schedule:fa..0f:g0', now() - interval '10 minutes', now() - interval '10 minutes');

-- ride E: accepted by driver D1, guard row present
INSERT INTO rides (id, passenger_id, driver_id, origin_lat, origin_lng, dest_lat, dest_lng, fare_cents, status, type,
                   idempotency_key, idempotency_operation, dispatch_generation, accepted_at, created_at, updated_at)
VALUES ('fa000000-0000-4000-8000-00000000000e', 'fa000000-0000-4000-8000-000000000c04',
        'fa000000-0000-4000-8000-000000000d01',
        26.1445, 91.7362, 26.1745, 91.7862, 19500, 'accepted', 'normal',
        'drill-idem-e', 'ride.create.solo', 1, now() - interval '9 minutes',
        now() - interval '10 minutes', now() - interval '9 minutes');
INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key, processed_at, created_at)
VALUES ('ride.dispatch.requested', 'ride', 'fa000000-0000-4000-8000-00000000000e', 1,
        '{"rideId":"fa000000-0000-4000-8000-00000000000e"}', 'ride.dispatch.requested:fa..0e:g1',
        now() - interval '10 minutes', now() - interval '10 minutes');
INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation, assigned_at)
VALUES ('fa000000-0000-4000-8000-000000000d01', 'fa000000-0000-4000-8000-00000000000e', 1, now() - interval '9 minutes');

COMMIT;
