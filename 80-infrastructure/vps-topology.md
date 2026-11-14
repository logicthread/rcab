---
title: VPS topology
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[deployment-topology]]
related: [[docker-compose]], [[nginx-reverse-proxy]], [[ssl-letsencrypt]], [[backups]], [[secrets-management]], [[observability]]
audience: both
---

# VPS topology

*One Linux box, well-isolated containers.*

## Host

- Ubuntu 24.04 LTS.
- Static IP. AAAA + A records pointing to it.
- Unattended-upgrades for security patches.
- UFW: deny inbound except 22 (key-only), 80, 443.
- SSH on 22 with key auth only; fail2ban for brute-force.

## Filesystem layout

*As deployed by `scripts/deploy/deploy.sh` (see `scripts/deploy/README.md`, "Host layout"). Postgres, Redis, OSRM, certbot, Loki, Prometheus, Grafana and Uptime Kuma data live in Docker **named volumes** (`pg-data`, `redis-data`, `osrm-data`, ...), not bind-mounted host directories.*

```
/opt/rcab/
  infra/{docker,observability}/   # written by deploy.sh --sync-infra (do not hand-edit)
  compose/.env                    # REDIS_PASSWORD, RCAB_VERSION, RCAB_REGISTRY ... (compose.env.example)
  compose/env/*.env               # api / postgres / grafana / backup env files (secrets; owner-managed)
  secrets/                        # age.key (public recipient), firebase-admin.json, ...
  backups/                        # encrypted nightly dumps + manifests (backup container)
```

## Users

- `rcab` non-root user; `docker` group membership.
- Application containers run as a non-root UID matching the host `rcab` user.

## Sysctls / OS tuning

- `vm.overcommit_memory = 1` (Redis recommendation).
- `net.core.somaxconn = 4096`.
- `transparent_hugepage = never` (Redis).

## See also
- [[deployment-topology]] · [[docker-compose]] · [[nginx-reverse-proxy]] · [[ssl-letsencrypt]]
- [[backups]] · [[secrets-management]] · [[observability]]
