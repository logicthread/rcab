---
title: RCAB-E8.S23 — Dispatch in three waves (3 / 5 / 7 km, 20 drivers each)
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S23
demo: 7
estimate: m
hitl: yes
depends_on: [[story-rcab-e8-s10-central-policy-config]], [[story-rcab-e8-s8-review-remediation-stage-c]], [[algo-top-k-dispatch]]
blocks:
affected_notes: [[algo-top-k-dispatch]], [[features-top-k-dispatch]], [[module-dispatch]], [[policy-config]]
owner: claude
audience: both
---

# RCAB-E8.S23 — Dispatch in three waves (3 / 5 / 7 km, 20 drivers each)

## Goal

Owner decision 2026-11-18: search wider and offer to more drivers. Dispatch had two waves (2 km and 4 km, 5 then 10 drivers). It now runs three, with 20 drivers per wave and a 7 km maximum.

## User-facing acceptance criteria

- Given a ride request, When dispatch starts, Then wave 1 offers up to 20 nearest eligible drivers within 3 km.
- Given no acceptance, When 30 s pass, Then wave 2 offers up to 20 more within 5 km; at 45 s wave 3 offers up to 20 more within 7 km; at 60 s the ride ends as `no_driver`.
- Given a driver was already offered in this generation, Then they are not offered again.

## Technical acceptance criteria

- Policy: `dispatch.k1/k2/k3` = 20 (`DISPATCH_K1..3`), `dispatch.r1/r2/r3Meters` = 3000 / 5000 / 7000 (`DISPATCH_R1..3_METERS`); new check `r2Meters <= r3Meters`; `docs/POLICY.md` regenerated.
- Wave 3 starts halfway between wave 2 and the hard fail (`waveThreeDelayMs`), so there is no new timing knob; scheduled windows scale the same way. Job id `dispatch-wave3-<trip>-g<g>`; removed on accept / cancel; the reconciler restores a lost wave-3 timer.
- `WaveTimeoutJob.waveNumber` accepts 1, 2 and 3; offers record `wave_number` 3.

## Test plan

- Unit: wave 3 parameters, timer arming (45 s), timeout handler, timer removal, reconciler restore (restore, live skip, too-late skip), `waveThreeDelayMs`, policy defaults and cross-field check. Full API suite 900 green.

## HITL stops

- Radii and counts are owner decisions (recorded in the policy `decision` column).

## Out of scope

- Per-vehicle dispatch filtering; changing offer TTL or hard-fail time.
- The ops demo harness (`scripts/demo/ops`) requires "Area C" to lie farther than `dispatch.r2Meters` (now 5 km) from Areas A and B; Area C is about 4.9 km from Area A, so it must move before that harness runs again (and beyond 7 km to also clear wave 3).

## See also
- [[epic-e8-production-hardening]] · [[algo-top-k-dispatch]] · [[features-top-k-dispatch]] · [[module-dispatch]] · [[policy-config]]
- [[story-rcab-e8-s22-snap-pickup-dropoff-to-road]]
