---
title: Story ID scheme
tags: [layer/delivery]
status: accepted
phase: both
depends_on: [[delivery-roadmap]]
related: [[story-template]], [[commit-story-linkage]]
audience: both
---

# Story ID scheme

*Stable, sortable, easy to type, easy to grep.*

## Format

```
RCAB-E<n>.S<m>
```

- `E<n>` — epic number (1..9 in Phase-0; new epics extend numerically; never re-used).
- `S<m>` — story number within the epic, monotonic; never re-used after creation. If a story is dropped, its ID stays as `status: dropped` in the file.
- Decimal example: `RCAB-E4.S7`.

## Examples

- `RCAB-E1.S1` — Foundation epic, story 1
- `RCAB-E4.S3` — Normal booking epic, story 3

## File naming

Each story is its own file under `95-delivery/stories/`:

```
95-delivery/stories/story-rcab-e1-s1-repo-scaffold.md
```

The slug uses the full ID + short kebab title. Wiki-links use the slug.

## Sub-tasks

We do **not** sub-number tasks (`S1.T1`, etc.). If a story is too big, split it into two stories. Atomic stories are the unit.

## See also
- [[story-template]] · [[stories-index]] · [[commit-story-linkage]] · [[delivery-roadmap]]
