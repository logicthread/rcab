---
title: Web client — pages & routes
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[web-nextjs-structure]]
related: [[journey-client-otp-signup]], [[journey-client-book-shared]], [[features-history-dashboard]]
audience: both
---

# Web client — pages & routes

*All client-facing URLs. Authenticated unless marked public.*

| Path | Surface | Notes |
|---|---|---|
| `/` (public) | Marketing landing | SSR; PWA install prompt for return visits |
| `/sign-in` (public) | Phone + OTP, Google | [[journey-client-otp-signup]] |
| `/book` | Booking screen | default landing post-auth |
| `/ride/:id` | Live ride tracking | redirects from /book once matched |
| `/history` | Past rides + dispute | [[features-history-dashboard]] |
| `/history/:id` | Single past ride detail | |
| `/settings` | Profile, saved places, link Google | [[journey-client-google-link]] |
| `/help` | Static FAQ | |

## Route conventions

- Authenticated routes live under `(app)/` segment with a layout that asserts auth + renders the bottom nav.
- Public routes live under `(public)/` and lazy-load Firebase auth only when reaching `/sign-in`.

## See also
- [[web-nextjs-structure]] · [[web-state-management]] · [[web-auth-firebase]]
