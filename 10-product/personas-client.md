---
title: Persona — Client
tags: [layer/product, kind/persona]
status: accepted
phase: both
depends_on: [[vision]]
related: [[personas-driver]], [[journey-client-otp-signup]]
audience: both
---

# Client persona

*A price-sensitive commuter in a tier‑2/3 city who books rides repeatedly along familiar corridors.*

## Snapshot

- Owns a low-to-mid range Android phone (≤ 4GB RAM common).
- Connectivity is 3G/4G with frequent dips.
- Comfortable with a phone-number-based signup; less comfortable with email-only flows.
- May or may not have a Google account; if they do, they expect "Sign in with Google" to work.
- Pays in cash today; expects UPI within a year.

## Top jobs-to-be-done

1. Get from A to B cheaply on a route I take regularly → use a **shared ride**.
2. Get to the station / airport reliably at a known time → **scheduled booking**.
3. Get a ride right now when no shared option fits → **normal booking**.
4. See where my ride/driver is right now → live tracking.
5. Look up a previous trip / contest a charge → **history dashboard**.

## Constraints we must respect

- Cold-start onboarding must work without an email.
- App must be a web app for Phase-0 (no Play Store dependency).
- The map should remain responsive on 3G — minimal tile fetches, prefetch the route.
- Forms in Hindi/regional language are out-of-scope Phase-0 but the UI should be ready for i18n.

## Anti-personas

- The premium-cab-using metro commuter — not our user. We will *not* optimize for that segment.
- Tourists — out of scope.

## See also
- [[journey-client-otp-signup]] · [[journey-client-book-shared]] · [[journey-client-book-normal]]
- [[features-history-dashboard]]
