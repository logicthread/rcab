---
title: SSL with Let's Encrypt
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[nginx-reverse-proxy]]
related: [[vps-topology]]
audience: both
---

# SSL with Let's Encrypt

*certbot in HTTP-01 mode; auto-renewal via systemd timer.*

> **Implementation status (verified against `infra/docker/docker-compose.prod.yml` and `infra/docker/nginx/`).** The sections below describe the intended host-level flow (`certbot --nginx`, systemd timer). The shipped stack differs: nginx runs in a container, `certbot` is a bare `certbot/certbot` service (`restart: "no"`, no command, no renewal loop) sharing the `certbot-etc` and `certbot-webroot` volumes, and the vhosts (`conf.d/*.conf`) hard-code the placeholder domain `rcab.example` (`app.`/`api.` hosts and `/etc/letsencrypt/live/rcab.example/`). First issuance (webroot challenge via `/.well-known/acme-challenge/`), replacing the placeholder domain, a scheduled `certbot renew` plus nginx reload, and an expiry alert are not automated or documented yet. They are part of RCAB-E8.S6 (TLS + HSTS + CSP audit) and the VPS bootstrap work.

## Initial issuance

```
sudo certbot --nginx \
  -d app.rcab.example \
  -d api.rcab.example \
  --agree-tos -m ops@rcab.example
```

## Renewal

- `certbot.timer` runs twice daily; nginx reloads on rotation.
- Alert (via [[observability]]) if cert age < 30 days remains.

## See also
- [[nginx-reverse-proxy]] · [[vps-topology]]
