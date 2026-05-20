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

```
/opt/rcab/
  compose/                # docker-compose.yml + env files
  data/
    postgres/             # named volume mount
    redis/                # AOF
    osrm/                 # PBF + index
  backups/                # local pg_dump staging
  certs/                  # certbot dir
/var/log/rcab/            # application logs
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
