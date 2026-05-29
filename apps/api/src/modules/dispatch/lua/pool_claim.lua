-- pool_claim.lua — atomic claim of a closed shared pool by a single driver.
--
-- KEYS[1] = pool:<ride_id>          (HASH)
-- ARGV[1] = driver_id (string)
-- ARGV[2] = claimed_at ISO-8601 (string)
--
-- Returns:
--    1  → claim succeeded; HASH now has claimed_by + claimed_at set
--    0  → already claimed by someone (race)
--   -1  → pool is not in a closed_* state (caller raced ahead of close)
--   -2  → pool HASH does not exist
--
-- The pool HASH must already be in state 'closed_full' or 'closed_timeout'
-- for a claim to be valid. 'closed_started' means the ride already started;
-- 'aborted' means dispatch hard-failed.

local state = redis.call('HGET', KEYS[1], 'state')
if not state then return -2 end
if state ~= 'closed_full' and state ~= 'closed_timeout' then return -1 end

if redis.call('HEXISTS', KEYS[1], 'claimed_by') == 1 then return 0 end

redis.call('HSET', KEYS[1],
  'claimed_by', ARGV[1],
  'claimed_at', ARGV[2])
return 1
