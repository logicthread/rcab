---
title: Epic E2 — Auth & Identity
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E2
demo: 1
depends_on: [[delivery-roadmap]]
related: [[module-auth]], [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[journey-client-otp-signup]], [[journey-client-google-link]]
audience: both
---

# Epic E2 — Auth & Identity

*Demo 1: "I am a real user"*

Phone OTP signup end-to-end + Google linking on top. JWT issue/refresh.

## Goal

Completing every story in this epic ⇒ Demo 1 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E2.S1 | [[story-rcab-e2-s1-otp-exchange]] — OTP exchange endpoint + Firebase Admin verifier | ▶ |
| RCAB-E2.S2 | [[story-rcab-e2-s2-jwt-refresh]] — rcab JWT issue/refresh + revocation | □ |
| RCAB-E2.S3 | [[story-rcab-e2-s3-web-otp-flow]] — Web OTP flow (reCAPTCHA + signInWithPhoneNumber) | □ |
| RCAB-E2.S4 | [[story-rcab-e2-s4-google-link]] — Google link/login endpoints + ID-token verify | □ |
| RCAB-E2.S5 | [[story-rcab-e2-s5-cookie-csrf]] — Refresh-token cookie + CSRF posture | □ |
| RCAB-E2.S6 | [[story-rcab-e2-s6-auth-integration-tests]] — Auth integration tests + negative cases | □ |

## Demo 1 headline (verbatim from [[delivery-roadmap]])

> I am a real user

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[module-auth]], [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[journey-client-otp-signup]], [[journey-client-google-link]]
