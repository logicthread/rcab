---
title: Nginx reverse proxy
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[vps-topology]]
related: [[docker-compose]], [[ssl-letsencrypt]]
audience: both
---

# Nginx reverse proxy

*TLS termination, static assets, WebSocket upgrade.*

## Server blocks

| Host | Behavior |
|---|---|
| `app.rcab.example` | Serves `apps/web/out/` static export |
| `api.rcab.example` | Proxies to `api:3000`. Handles WebSocket upgrade for `/socket.io/` |
| `*.rcab.example` (catch-all) | 308 → `https://app.rcab.example` |

## Critical config snippets

```nginx
# WebSocket upgrade
location /socket.io/ {
  proxy_pass http://api:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 7d;        # long-lived
  proxy_send_timeout 7d;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Rate limiting at the edge
limit_req_zone $binary_remote_addr zone=writes:10m rate=60r/m;
location /v1/ {
  limit_req zone=writes burst=20 nodelay;
  proxy_pass http://api:3000;
  # ... usual proxy_set_header lines
}
```

## TLS

- HSTS enabled, `max-age=31536000; includeSubDomains; preload`.
- TLS 1.2 + 1.3 only.
- Certs via [[ssl-letsencrypt]].

## See also
- [[vps-topology]] · [[docker-compose]] · [[ssl-letsencrypt]]
