---
title: Glossary
tags: [moc, glossary]
status: living
audience: both
---

# Glossary

Domain terms used across the vault. When a note uses one of these, it should link back here on first use.

| Term | Definition |
|---|---|
| **Client** | An end-user who books rides. Distinct from `User`, which is the auth-level record. |
| **Driver** | A user who has been approved to accept ride requests and operates a [[entity-vehicle]]. |
| **Ride** | A completed or in-progress trip executed by one driver. May serve one or more [[entity-ride-request]]s if it is a [[entity-shared-ride]]. |
| **Ride Request** | A booking placed by a client. Becomes part of a ride when matched. A request can be `normal`, `shared`, or `scheduled`. |
| **Shared Ride** | A ride that pools multiple ride requests whose origins/destinations sit close to a common [[entity-route]]. See [[features-shared-rides]]. |
| **Route** | An origin-destination corridor with detectable similarity. The unit on which shared-ride matching operates. |
| **Top-K Dispatch** | When a normal booking is placed, the K nearest available drivers are notified in parallel (or in waves). For Phase-0, K = 5. See [[algo-top-k-dispatch]]. |
| **Active driver** | A driver who has toggled "online" and is currently eligible to receive ride requests. See [[sm-driver-availability]]. |
| **Pick / Drop** | Origin and destination, in user-facing language. |
| **OSM** | OpenStreetMap. Used for client-facing map, geocoding, and routing in-app. See [[integration-openstreetmap]]. |
| **OSRM** | Open Source Routing Machine — gives us routes/ETAs from OSM data. See [[integration-osrm]]. |
| **Nominatim** | OSM geocoder. Address → coordinates and vice versa. See [[integration-nominatim]]. |
| **FCM** | Firebase Cloud Messaging — push notifications, primarily for the driver app. See [[integration-fcm]]. |
| **DLT** | Distributed Ledger Telecom — India's mandatory SMS-sender registration regime. Phase-0 sidesteps it by using Firebase Phone Auth. |
| **Phase-0 / Phase-1** | Phase-0: ≤5k clients, ≤100 drivers, single VPS. Phase-1: scale-out, multi-platform, possibly multi-DB. See [[phase-0]], [[phase-1]]. |
| **ADR** | Architecture Decision Record. Template: [[adr-template]]. |
| **MOC** | Map of Content — a hub note that links to many others (e.g., [[HOME]]). |

## See also
- [[HOME]] · [[LLM-INSTRUCTIONS]] · [[reading-paths]]
