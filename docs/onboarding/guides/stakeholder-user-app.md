# Stakeholder guide: Passenger web app

For product owners, support and anyone who needs to understand what a passenger experiences. No technical knowledge needed. Videos are in the [web video index](../videos/web/INDEX.md); IDs below (W01 to W10) match that index.

## What a passenger can do

1. **Open the site and sign in with a phone number** (W01 landing, W02 sign-in). The passenger enters a phone number, receives a one-time code by SMS, and types it in. No password.
2. **Choose pickup and destination** on a map or by typing an address (suggestions appear after 3 characters).
3. **See a price and route** (the quote). The quote stays valid for 5 minutes; after that the app asks for a fresh one.
4. **Pick the ride type**: normal (a private ride), shared (a pooled ride, cheaper), or scheduled (book for later).
5. **Book and watch the ride** live: the status banner updates and the driver's car moves on the map.
6. **Rate the driver** (1 to 5 stars, optional comment) after the trip, or skip.
7. **Sign out** (W10).

## Step by step: a normal ride (W03)

| Step | What the passenger sees | Status |
|---|---|---|
| Quote | Route, distance and fare | (none yet) |
| Book | "Finding your driver..." | `requested` / `dispatching` |
| A driver accepts | "Driver assigned, getting ready" | `accepted` |
| Driver heads to pickup | "Your driver is on the way" | `en_route` |
| Driver at pickup | "Your driver has arrived" | `arrived` |
| Trip underway | "On the way to your destination" | `in_progress` |
| Finished | "Trip complete", then a rating prompt | `completed` |

If nobody accepts within about a minute (two search rounds: nearby drivers first, then a wider area), the app says "No driver available, please try again" (`no_driver`, W06). Nothing is charged; the passenger can book again.

## Status meanings

| Status | Meaning |
|---|---|
| requested / dispatching | The system is looking for a driver. |
| accepted | A driver took the ride. |
| en_route | The driver is driving to the pickup point. |
| arrived | The driver is at the pickup point. |
| in_progress | The trip has started. |
| completed | The trip is finished. |
| cancelled | The ride was cancelled (by the passenger or the driver). |
| no_driver | No driver accepted. |
| no_show | The driver waited and reported that the passenger did not turn up. |

## Cancelling (W04, W05)

- A passenger can cancel any time **before the trip starts**: while searching, after a driver accepts, while the driver is on the way, or after the driver has arrived. Once the trip is `in_progress` the app does not allow cancelling.
- **There is no cancellation fee in Phase-0.**
- If the **driver cancels** or reports a **no-show**, the ride ends and the passenger can book again. A driver can only report a no-show after waiting 5 minutes at the pickup point (W05).
- Booking twice by accident (double tap or poor connection) does not create two rides; the app retries safely.

## Shared rides (W07)

Choosing "Share" lets the system pool the passenger with others going the same way.

- The first passenger opens a pool; it stays open for up to **60 seconds** (or until it is full, maximum 3 seats) so others can join.
- The pool badge shows how many seats are taken. When it closes (full or timed out), a driver is offered the multi-stop trip. The driver picks up and drops off each passenger in order.
- **The price is fixed when the passenger joins.** Quote shown is the 2-seat shared price (the price a pair would pay); the actual price is set at the moment of joining and does not change if more people join later (so an early joiner does not get a discount for a pool that fills up, and no refunds happen). This is a Phase-0 rule; the owner has not yet decided a fairer policy (known limitation).
- If no pooling partner is found, the ride still goes ahead with the passenger alone, and a banner tells them so.

## Scheduled rides (W08)

- Book for a pickup time between **15 minutes and 24 hours** from now.
- Nothing is dispatched immediately. About **10 minutes before pickup** the system starts looking for a driver.
- If no driver answers, the screen shows **"Still looking for a driver, we'll keep trying until <time>"** (the searching state). The system keeps trying until **30 minutes after the pickup time**, then ends the ride as no driver available.
- The passenger can cancel before or after the search starts (W08 shows create, searching, cancel).

## Reloading and poor connections (W09)

Refreshing the page or briefly losing network does not lose the ride: the app signs back in silently and restores the live tracking.

## Known limitations

- No in-app payment; fares are informational, collected outside the system.
- No ride history page or driver rating display yet (planned in E7).
- Shared-fare readjustment, member cancellation inside a pool, and cancellation fees are undecided or not offered.
- Driver availability depends on the pilot area; the dev map covers the Guwahati region only.
- Too many sign-in attempts in a minute (more than 10) are temporarily blocked.

## Where to learn more

Feature descriptions: `10-product/features-normal-booking.md`, `features-shared-rides.md`, `features-scheduled-booking.md`; journeys: `10-product/journey-client-*.md`. Every number above is a configurable policy value listed in `docs/POLICY.md`.
