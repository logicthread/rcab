# Quoting and pricing

How a fare is computed, how a quote is locked into a short-lived token, and how a shared seat is priced. The money rules are all policy knobs; the only fare logic that is still a stand-in is the shared-fare readjustment (RCAB-E8.S9, pending).

Back to [README](../README.md) · next steps: [normal-booking](normal-booking.md), [shared-rides](shared-rides.md), [scheduled-rides](scheduled-rides.md).

## What it does

- `POST /v1/rides/quote` routes pickup to dropoff on OSRM, prices the **solo fare**, and returns it with the route geometry and a **signed quote token**. For `type=shared` it also returns an indicative per-seat price.
- `POST /v1/rides` (normal or scheduled) must carry that token; the booking commits exactly the fare the user was shown, and rejects the request if the route differs or the token is stale.
- A shared seat is priced separately, **inside the join** (the quote endpoint's number is only an estimate), and then fixed for that passenger.

## User-visible behaviour

- Web `/book`: choose pickup and dropoff on the map or with address search (Nominatim, debounced 400 ms, min 3 chars) or one of the preset Guwahati trips. Once both points are set a quote is requested automatically; a re-quote happens whenever either point or the ride type changes. The panel shows distance, duration and the fare; for Share it shows the indicative per-seat price. Default ride type is **Share**; the other option is **Private**.
- If OSRM cannot route (points outside the loaded graph, OSRM down) the user sees "routing unavailable" copy. If the quote expired before submit, the web re-quotes and says so.
- Videos: normal flow W03, shared flow W07 ([web index](../videos/web/INDEX.md)).

## API

`POST /v1/rides/quote` (client role) body `{ type: normal|shared|scheduled, originLat, originLng, destLat, destLng }`. Response:

```json
{ "type": "normal", "distanceM": 5120, "durationS": 780,
  "soloFare": { "amount": 14280, "currency": "INR" },
  "geometry": { "type": "LineString", "coordinates": [[91.73, 26.14], "..."] },
  "quoteToken": "<jwt>",
  "sharedEstimate": { "perSeatPrice": {}, "seatMultiplier": 0.7, "detourFactor": 1, "seatCount": 2 } }
```

`sharedEstimate` is present only for `type=shared`. A scheduled quote is priced exactly like a normal one; the pickup time is supplied later at booking.

Errors: 503 when OSRM cannot be reached (response body message `routing_unavailable`; note the envelope's `code` field reads `internal_error` for this exception, so clients key on status 503), 400 on coordinate validation, 403 for non-clients.

At booking time the quote token produces: 400 `invalid_quote` (missing, tampered), 400 `quote_expired`, 400 `quote_mismatch` (coordinates differ by more than 1e-6 degrees from the quoted route).

## The maths

All amounts are integer **paise**, currency `INR`. Fields are called `fareCents` / `amount` for historical reasons.

Solo fare, rounded to the nearest paisa:

```
fare = FARE_BASE_CENTS + FARE_PER_KM_CENTS * km + FARE_PER_MIN_CENTS * minutes
     = 4000 + 1500 * km + 200 * min        (defaults: Rs 40 + Rs 15 per km + Rs 2 per min)
```

`km` and `minutes` come from the OSRM route (`overview=false`). Route metrics are cached in Redis for 1 hour under `pricing:dist:<geohash7(origin)>:<geohash7(dest)>`; an OSRM call is bounded by `PRICING_OSRM_TIMEOUT_MS` (3 s).

Shared seat fare (`PricingService.quoteSeatFromMetrics` / `quoteSeatInItinerary`):

```
seatMultiplier = 1.0 (1 seat) | SEAT_MULTIPLIER_2 = 0.70 (2 seats) | SEAT_MULTIPLIER_3 = 0.55 (3+)
detourFactor   = clamp(rideDistance / directDistance, 1.0, 1 / seatMultiplier)
perSeat        = round(soloFare * seatMultiplier * detourFactor)
```

- `rideDistance` is the passenger's own distance along the **actual ordered itinerary** (their pickup stop, through every intermediate stop, to their dropoff stop), obtained from one OSRM call for the legs; `directDistance` is their direct route. The clamp means a seat never costs more than the solo fare and detour never discounts.
- `seatCount` is the pool size **after** this passenger joins. The first passenger (opener) pays the 1-seat multiplier, i.e. the solo price; later joiners pay 0.70 or 0.55 of theirs.
- The quote endpoint's `sharedEstimate` assumes `SHARED_QUOTE_SEATS` (2) seats and no detour.
- Driver payout helper: `driverPayout(seatPrices) = sum * (1 - PLATFORM_COMMISSION_RATE)` (20 % commission). It exists in `PricingService`; no payout or settlement is recorded anywhere in Phase-0.

## Fare policy for shared seats (stand-in)

`SHARED_FARE_POLICY = 'fixed_at_join'` (code-fixed knob `pricing.sharedFarePolicy`): the per-seat fare is quoted once at join, stored in `pool_member.agreed_fare_cents` (set by a trigger-guarded NOT NULL since migration 0017) and returned as `perSeatPrice` with `farePolicy: "fixed_at_join"`. Later joiners do not change an earlier member's fare, so a pool that grows from 2 to 3 seats gives the first two passengers no extra discount and no refund. **RCAB-E8.S9 will replace this** with a real policy (discount as the pool grows, adjustments, member cancellation, settlement); grep for `SHARED_FARE_POLICY` to find every place that encodes the stand-in. Pricing is optimistic: it runs with no lock held and is re-done up to `MATCHING_JOIN_PRICE_RETRIES` (3) times if the pool changed meanwhile; see [shared-rides](shared-rides.md).

A solo ride's fare is fixed at booking from the quote token (`rides.fare_cents`); the driver sees it in the offer (`fareCents`). Nothing charges or settles it.

## Data

`rides.fare_cents`, `pool_member.agreed_fare_cents` (legacy `quoted_fare_cents`), no payments table. Redis `pricing:dist:*`, `osrm:poly:*` (polyline cache, same 1 h TTL, used by similarity and quote geometry).

## Policy knobs

[Pricing and fares](../../POLICY.md#pricing--fares): `FARE_BASE_CENTS`, `FARE_PER_KM_CENTS`, `FARE_PER_MIN_CENTS`, `SEAT_MULTIPLIER_2`, `SEAT_MULTIPLIER_3`, `PLATFORM_COMMISSION_RATE`, `SHARED_QUOTE_SEATS`, `pricing.sharedFarePolicy`, `QUOTE_TTL_MS` (5 min), `PRICING_OSRM_TIMEOUT_MS`. Cross-field rule: a fuller pool is never dearer per seat (`SEAT_MULTIPLIER_3 <= SEAT_MULTIPLIER_2`) and `SHARED_QUOTE_SEATS <= MATCHING_MAX_SEATS` ([Cross-field rules](../../POLICY.md#cross-field-rules)). Change a default in `apps/api/src/config/policy/policy.schema.ts`, then `pnpm policy:doc`.

## Code entry points

`apps/api/src/modules/pricing/{pricing.service,money,shared-fare-policy,pricing.types}.ts`; `modules/rides/{rides.controller.ts (quote, verifyQuote, coordsMatch),quote-token.service.ts}`; `modules/matching/route-similarity.service.ts` (`getRouteGeometry`). Web: `apps/web/src/lib/booking/api.ts` (`fetchQuote`), `store.ts`, `app/book/book-client.tsx`.

## Tests

`pricing.service.spec.ts`, `quote-token.service.spec.ts`, `rides.controller.spec.ts`; integration `pool-fare.int.spec.ts`, `pool-optimistic-pricing.int.spec.ts`, `osrm-connectivity.int.spec.ts`; web `lib/booking/{api,store}.test.ts`, `app/book/book-client.test.tsx`.

## Known gaps

- Shared fare readjustment (E8.S9) is a stand-in; there is no refund, adjustment or settlement and no payment of any kind.
- The quote token is not bound to the user: it proves the fare and route, not who asked. This is acceptable because booking is also authenticated and idempotent, but do not treat it as an entitlement.
- `rides.fare_cents` is naming debt (paise, not cents); `me.quotedFareCents` in the pool snapshot actually carries the agreed fare.
- Scheduled quoting has no web UI (see [scheduled-rides](scheduled-rides.md)).
- OSRM unavailable errors carry `code: internal_error` in the envelope; clients must key on status 503.
