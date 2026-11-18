---
title: RCAB-E8.S16 — Web design system, light/dark themes and restyled screens
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S16
demo: 7
estimate: l
hitl: yes
depends_on: [[web-nextjs-structure]], [[web-state-management]]
blocks: [[story-rcab-e8-s18-account-menu-profile-ride-history]]
affected_notes: [[web-nextjs-structure]], [[web-pages-routes]], [[tech-stack]]
owner: claude
audience: both
---

# RCAB-E8.S16 — Web design system, light/dark themes and restyled screens

## Goal

The web client was unstyled inline CSS (Tailwind installed but never wired). Give it one production-ready look: a token layer, a typed `Button`, mobile-first layouts and a light/dark/system theme, and restyle the existing screens (home, sign-in, booking, ride tracking) without changing behaviour.

## User-facing acceptance criteria

- Given any screen, When it renders, Then it uses the rcab palette (ink, one amber accent, quiet neutrals) and Bricolage Grotesque, and works at 390 px width with 44 px tap targets.
- Given the menu theme switch (System / Light / Dark), When a choice is made, Then the whole app switches at once and the choice survives a reload; System follows the device.
- Given a disabled button (for example "Submit rating" before a star is chosen), When it renders, Then its label stays readable (flat grey, not a faded fill).
- Given keyboard use, When tabbing, Then focus is always visible; given reduced-motion, Then animations are suppressed.

## Technical acceptance criteria

- Tailwind wired (`postcss.config.mjs`, `globals.css`, tokens as RGB CSS variables, `.dark` overrides, `tailwind.config.ts` colour names).
- `components/ui/button.tsx` (cva variants accent / primary / secondary / ghost / danger, sizes, `loading`), `spinner.tsx`, `theme-toggle.tsx`, `providers.tsx` (next-themes `class` strategy + Sonner toaster).
- New dependencies: `class-variance-authority`, `clsx`, `sonner`, `next-themes`, `vaul` (picked per the `pick-ui-library` list; all MIT, no service or cost).
- Existing unit suites stay green; no test depends on inline styles.

## Test plan

- Unit: existing web suites (211 at start); menu/theme tests live in S18.
- Visual: home and sign-in checked at 390 px in light and dark (Playwright screenshots).
- Build: `pnpm --filter @rcab/web build`.

## HITL stops

- Design direction (taxi-signage ink + amber, Bricolage Grotesque) confirmed by the owner before the build.

## Out of scope

- Driver app theming ([[story-rcab-e8-s20-driver-app-theme-menu]]).
- Map tile theming (OSM tiles stay light in both themes).

## Notes / questions

- Soft stop: five small UI libraries added; rejected alternative was a full component kit (shadcn/MUI).
- Dev gotcha: restart `next dev` after editing `tailwind.config.ts` (new colour names were not picked up live).

## See also
- [[epic-e8-production-hardening]] · [[web-nextjs-structure]] · [[web-pages-routes]]
- [[story-rcab-e8-s17-booking-vehicle-picker-share-flag]] · [[story-rcab-e8-s18-account-menu-profile-ride-history]]
