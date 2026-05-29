---
title: RCAB-E4.S1 — Web booking screen — Leaflet pick/drop, Nominatim geocode, live OSRM quote
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e5-s6-web-booking-share-ui]], [[journey-client-book-normal]], [[web-pages-routes]]
affected_notes: [[journey-client-book-normal]], [[web-pages-routes]]
owner: claude
audience: both
---

# RCAB-E4.S1 — Web booking screen — Leaflet pick/drop, Nominatim geocode, live OSRM quote

## Goal

The web booking screen is the client's entry point to a normal (private) ride. Today it uses hardcoded `PRESET_TRIPS` radios and the "Private" path is stubbed off ("Private booking ships with E4"). This story replaces presets with a real map surface: a Leaflet map where the client sets pickup + dropoff by tapping the map or searching an address (Nominatim forward + reverse geocode), then sees a live fare/route quote from the **existing** `POST /v1/rides/quote` endpoint. This delivers the Demo-3 booking surface. Booking *submission* for private rides (the idempotent request endpoint + enabling the "Book" button) is owned by RCAB-E4.S2 — S1 stops at a live, accurate quote.

## User-facing acceptance criteria

- `Given` the booking page loads, `When` the client types ≥3 characters in the pickup field, `Then` Nominatim address suggestions appear within ~1 s and selecting one drops a pickup marker on the map and centres on it.
- `Given` the client taps a point on the map, `When` the tap registers, `Then` a marker is placed and its address is reverse-geocoded into the currently-active (pickup or dropoff) field.
- `Given` both pickup and dropoff are set, `When` the quote resolves, `Then` the client sees distance (km), ETA (min) and the solo fare returned by `POST /v1/rides/quote`.
- `Given` both pickup and dropoff are set, `When` the quote resolves, `Then` the OSRM road-route line is drawn on the map between the two markers (real road geometry, not a straight line).
- `Given` pickup or dropoff changes, `When` the new pair is valid, `Then` the quote refreshes (debounced) and any in-flight stale quote result is discarded.
- `Given` the client picks coordinates the loaded OSRM graph cannot route between, `When` the quote is attempted, `Then` a clear "we can't route between these points yet" message is shown (no silent failure / no NaN fare).
- `Given` ride type = "Private", `When` a valid quote is shown, `Then` the fare shown is the solo fare with no per-seat breakdown. (The "Book" submit remains gated to E4.S2.)

## Technical acceptance criteria

- Web deps: add `leaflet` + `react-leaflet` (+ `@types/leaflet`); import Leaflet CSS. Map tiles from the OSM tile server with valid attribution + `User-Agent`.
- New client component `MapPicker` under `apps/web/src/app/book/`: renders the Leaflet map, pickup + dropoff markers, click-to-set-active-marker, marker drag to refine.
- New `AddressSearch` component: debounced Nominatim `/search` (forward geocode) + `/reverse` lookup; throttled to ≤1 req/s per Nominatim usage policy; sets a descriptive `User-Agent`.
- `useBookingStore` (`apps/web/src/lib/booking/store.ts`): replace the `trip: PresetTrip` model with `pickup` / `dropoff` `{ lat, lng, label }`. Quote key derives from coordinates, not a preset id. Keep 2–3 Guwahati quick-pick seeds for fast demo entry.
- `fetchQuote` sends `originLat / originLng / destLat / destLng` from the chosen coordinates to `POST /v1/rides/quote` (already returns `soloFare`, `distanceM`, `durationS`).
- **Backend (single change):** extend `QuoteResponse` with `geometry` (GeoJSON `LineString`). The OSRM route call uses `overview=full&geometries=geojson`; `PricingService.quoteSolo` (or its route-metrics source) returns the geometry alongside distance/duration; the controller passes it through. `MapPicker` renders the route `Polyline` from `quote.geometry`.
- Nominatim base URL behind env `NEXT_PUBLIC_NOMINATIM_URL` (default `https://nominatim.openstreetmap.org`) so Phase-1 can point at a self-hosted instance.
- Out-of-region / OSRM `NoRoute` from `/quote` surfaces as the routing-unavailable message (per UAC #5).

## Test plan

- **Unit (Vitest / React Testing Library):**
  - `AddressSearch` debounces input and renders suggestions from a mocked Nominatim response; selecting a suggestion updates store coordinates.
  - `MapPicker` click handler sets the active marker and triggers a reverse-geocode call.
  - Quote key recomputes when coordinates change (not when only the label changes).
  - `MapPicker` renders a route `Polyline` when `quote.geometry` is present.
- **Integration (API, Testcontainers — real Redis, mocked OSRM HTTP):** `RouteSimilarityService.getRouteGeometry` returns a GeoJSON `LineString` (>2 coordinates) and caches it under `osrm:poly:` in real Redis. OSRM unreachable / no-route surfaces as `OsrmUnavailableException` (503 `routing_unavailable`, not a 500).
- **Web component integration (Vitest + RTL):** `AddressSearch` debounces a mocked Nominatim call and fires `onSelect`; `MapPicker` (react-leaflet mocked) renders a route `Polyline` only when geometry is present; booking store re-quotes on coordinate change and clears on swap/preset.
- **Manual demo walk (HITL):** full `/book` flow on `localhost` — search/tap pick + drop in Guwahati → live quote + route line → `Book share`. Dev signs off (see HITL stops).
- Load: n/a.

## HITL stops

1. **External services** — Nominatim (geocoding) **and** the OpenStreetMap tile server (map tiles). Both are free public services governed by usage policies (≤1 req/s, valid `User-Agent`, no bulk). Dev traffic is low so Phase-0 is acceptable, but introducing them is an external-dependency decision → dev sign-off. Phase-1 must self-host both before production load.
2. **Demo coordinates** — the OSRM dev graph covers **NE-India (Guwahati) only**. The Demo-3 booking walk must use NE-India coordinates, or load a different PBF (large download + container rebuild). Confirm demo locale before the walk.
3. **Demo-3 booking-screen walk-through** — dev signs off the map / geocode / quote UX on `localhost` before merge.

## Out of scope

- Booking submission / ride request for private rides — RCAB-E4.S2 (idempotent request endpoint + enabling "Book").
- Saved / favourite places, address book — Phase-1.
- Anything driver-side — E4.S5+.

## Notes / questions

- **Route polyline (resolved 2026-05-29):** dev chose to add `geometry` (GeoJSON `LineString`) to `QuoteResponse` now and draw the real OSRM route line. This is the single backend change in S1.
- **Preset seeds:** keep 2–3 Guwahati quick-pick buttons as seeds for fast demo entry, or remove entirely in favour of search? **Default: keep seeds.**
- The Private "Book" button stays disabled (copy pointing at E4.S2) until S2's request endpoint lands.
- **Playwright not set up (decision 2026-05-30):** no Playwright config exists in `apps/web` (E5.S6 also shipped RTL-only despite its plan mentioning it). Standing it up = new infra + a browser download (system-level / HITL). Followed the repo precedent: Vitest + RTL component tests + the manual demo walk for the e2e gate. A real Playwright harness is deferred to a dedicated tooling story.
- Browser `fetch` cannot set a `User-Agent` (forbidden header); Nominatim identification falls back to the auto-sent Referer. Debounce enforces the ≤1 req/s policy.

## See also

- [[epic-e4-normal-booking]] · [[journey-client-book-normal]] · [[features-normal-booking]]
- [[web-pages-routes]] · [[story-rcab-e5-s6-web-booking-share-ui]]
