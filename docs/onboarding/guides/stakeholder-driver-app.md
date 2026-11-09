# Stakeholder guide: Driver app

For driver managers, trainers and stakeholders. No technical knowledge needed. The app is Android (Flutter). Videos are in the [driver-app video index](../videos/driver-app/INDEX.md); IDs D01 to D08 match that index.

## 1. Getting started (D01, D02)

1. **Sign in with a phone number** and the SMS one-time code (D01).
2. **Register a vehicle** (D02): type, registration number, seats. **A driver with no active vehicle receives no ride offers**, and a vehicle needs enough seats for the ride (shared rides need more).
3. **Phone setup**: some phone makers (OEMs) stop background apps to save battery. The app shows an onboarding sheet explaining which settings to change, and a banner if the system killed the app in the last 24 hours. Trainers should walk every driver through it.

## 2. Going online (D03)

- Toggle **Online** on the home screen. The app then sends the phone's location every few seconds (only if it moved at least 10 metres) and keeps a service running.
- If the app is silent for about **60 seconds** the system takes the driver offline automatically. Reopen the app and toggle online again.
- Go **Offline** to stop receiving offers.

## 3. Offers (D04, D05)

- An offer shows pickup, destination, fare and a **12-second countdown**.
- **Accept** to take the ride. If another driver was faster, the app says the offer was lost.
- **Decline** or let the countdown run out and the offer goes to other drivers. No decline penalty is defined in the policy table (`docs/POLICY.md`).
- A driver can have **one active ride at a time** (solo or shared).

Search rounds: the first ride request goes to up to 5 nearest drivers within 2 km; if nobody accepts after 30 seconds, up to 10 drivers within 4 km. Scheduled rides use a longer 4-minute window.

## 4. Running a normal ride (D04)

Steps the driver confirms in order: **on my way** (`en_route`), **arrived**, **start trip** (`in_progress`), **complete**. A navigation button hands off to Google Maps. After completion the app asks for a **rating** of the passenger (1 to 5 stars, optional comment; skippable).

## 5. Shared rides (D06)

A shared offer lists several stops (pickups and drop-offs) in order. After accepting, the app shows the stop list; the driver confirms each **pickup** and **drop-off** in sequence (out-of-order confirmation is rejected). The pool closes when full (3 seats) or 60 seconds after opening, then the offer goes out.

## 6. Cancel and no-show (D07)

- The driver can **cancel** a ride at any stage, with a required reason (for example passenger not reachable, vehicle issue, other).
- **No-show**: the button unlocks only **5 minutes after arriving** at the pickup. The server re-checks the time. Press it only if the passenger genuinely did not appear.
- Passengers can cancel before the trip starts; the driver is told and freed immediately.
- No cancellation fees exist in Phase-0.

## 7. Earnings and profile (D08)

- **Profile** shows vehicle details and lets the driver edit the vehicle or sign out.
- **Earnings**: the screen is currently a placeholder ("coming in E7"). The platform commission is configured at 20% of the gross shared fare, but payout reporting is not built yet.
- Ratings given by passengers are stored but not yet displayed (E7).

## 8. Troubleshooting for trainers

| Symptom | Likely cause | Fix |
|---|---|---|
| Driver gets no offers | Offline, no active vehicle, vehicle too small for a shared ride, already on a ride, or silent for 60 s | Check each in that order; toggle online again. |
| App goes offline by itself | Phone killed the background service | Follow the OEM sheet settings. |
| "Offer lost" | Another driver accepted first | Normal. |
| Cannot press no-show | Under 5 minutes since arrival | Wait; the timer is shown. |
| Stuck on a ride after a network drop | Reconnect restores the current assignment | Reopen the app; escalate to the maintainer if it persists. |

More detail: `50-clients/driver-screens.md`, `10-product/journey-driver-*.md`, and the config values in `docs/POLICY.md` (driver app section).
