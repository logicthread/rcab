-- Atomically claim a seat in a shared-ride pool.
--
-- KEYS[1] = pool:<ride_id>:seats   (Redis STRING counter)
-- ARGV[1] = max_seats              (integer cap)
-- ARGV[2] = pg_seats               (integer, current Postgres value — seeds key on cold start)
--
-- Returns: new seat count (≥ 1) on success, -1 if pool is already full.
local key      = KEYS[1]
local max      = tonumber(ARGV[1])
local pg_seats = ARGV[2]

-- Seed from Postgres if the key has never been written to Redis.
redis.call('SET', key, pg_seats, 'NX', 'EX', '300')

local current = tonumber(redis.call('GET', key))
if current == nil or current >= max then
  return -1
end
redis.call('EXPIRE', key, 300)
return redis.call('INCR', key)
