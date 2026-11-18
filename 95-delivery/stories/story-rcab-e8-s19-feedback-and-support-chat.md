---
title: RCAB-E8.S19 — In-app feedback form and support chat
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S19
demo: 7
estimate: m
hitl: yes
depends_on: [[story-rcab-e8-s18-account-menu-profile-ride-history]], [[schema-postgres]], [[migrations]]
blocks:
affected_notes: [[rest-endpoints]], [[schema-postgres]], [[data-model]], [[migrations]], [[module-map]], [[web-pages-routes]]
owner: claude
audience: both
---

# RCAB-E8.S19 — In-app feedback form and support chat

## Goal

"Give feedback" and "Contact help" must work inside the apps and reach the database, not open an email client. Used by riders (web) and drivers (driver app).

## User-facing acceptance criteria

- Given `/feedback`, When a category and message are sent, Then it is stored and a "Thanks, we got it" screen shows; an empty message cannot be sent; a failed send keeps the text and explains.
- Given `/help`, When the first message is sent, Then it appears in a chat thread followed by an automatic acknowledgement from "rcab support"; later support replies appear within ~5 s without a refresh.

## Technical acceptance criteria

- Migration `0021_account_feedback_support.sql`: `feedback` (user, role, category `bug|idea|compliment|other`, message 1-2000, created_at) and `support_message` (user, sender `user|support`, body 1-2000, created_at, index user+time); `schema.ts` mirrors it.
- `POST /v1/feedback` (201 `{id}`), `GET /v1/support/messages` (newest 200, oldest first), `POST /v1/support/messages` (returns the created messages, plus the acknowledgement on a user's first message). Validation errors use the standard `validation_error` envelope.
- One conversation per user (the thread is the user's rows). Roles are recorded from the JWT.

## Test plan

- Unit: controller specs, DTO validation (category, trim, bounds); web feedback / help pages; driver-app screens.
- Live: posted feedback and chat through the UI against the dev DB and checked the rows.

## HITL stops

- New tables (owner approved the feature).

## Out of scope

- A staff/admin inbox: replies are inserted into `support_message` with `sender = 'support'` (SQL) until an admin tool exists. Push notification on reply, attachments, ticketing, closing a conversation.

## See also
- [[epic-e8-production-hardening]] · [[rest-endpoints]] · [[schema-postgres]] · [[migrations]]
- [[story-rcab-e8-s18-account-menu-profile-ride-history]] · [[story-rcab-e8-s20-driver-app-theme-menu]]
