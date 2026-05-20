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
