---
title: RCAB-E8.S20 — Driver app: themes, side menu, trip history, feedback, help, profile
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S20
demo: 7
estimate: m
hitl: no
depends_on: [[story-rcab-e8-s18-account-menu-profile-ride-history]], [[story-rcab-e8-s19-feedback-and-support-chat]], [[driver-flutter-structure]]
blocks:
affected_notes: [[driver-screens]], [[driver-flutter-structure]], [[driver-state-management]]
owner: claude
audience: both
---

# RCAB-E8.S20 — Driver app: themes, side menu, trip history, feedback, help, profile

## Goal

Bring the driver app in line with the web client: the same ink and amber palette in light and dark, and a side menu with the same destinations.

## User-facing acceptance criteria

- Given the driver app, When System / Light / Dark is chosen in the menu, Then the theme switches immediately and is remembered across launches.
- Given the home screen, When the hamburger is pressed, Then a drawer offers Profile and vehicles, Trip history, Give feedback, Contact help, the theme switch and Sign out (with the existing confirmation).
- Given Trip history, When it loads, Then trips show date, fare and status (empty / error states, pull to refresh).
- Given Profile, When it loads, Then name, rating (average and count) and trip count show with a name edit; vehicles stay as before.
- Feedback and Contact help behave as on web ([[story-rcab-e8-s19-feedback-and-support-chat]]).

## Technical acceptance criteria

- `core/theme/app_theme.dart` (`buildTheme`, `ThemeModeNotifier` persisted in `shared_preferences`), `features/menu/app_drawer.dart`, `features/{history,feedback,help}/`, `features/account/account_api.dart`; routes `/history`, `/feedback`, `/help`.
- No new packages (dates and rupees are formatted by small helpers).
- Existing keys (`profile_button`, `sign_out_button`, ...) are unchanged so earlier tests keep passing.

## Test plan

- Widget: 11 new tests (feedback, help, history, drawer navigation and theme, theme data, formatters); full suite 288 green; `flutter analyze` clean.
- Manual: ran on the Android emulator, signed in with the registered driver account, accepted a ride.

## Out of scope

- Earnings screen content (still [[features-history-dashboard]] / E7.S4). Visual pass of every existing screen in dark mode.

## See also
- [[epic-e8-production-hardening]] · [[driver-screens]] · [[driver-flutter-structure]]
- [[story-rcab-e8-s16-web-design-system-themes]] · [[story-rcab-e8-s18-account-menu-profile-ride-history]]
