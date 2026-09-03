# Cloudflare Tunnel for quire.ezragubbay.com

The Pi has no inbound ports. The `cloudflared` container in `compose.yml` (profile `tunnel`) opens an outbound connection to Cloudflare, which routes `quire.ezragubbay.com` down it. Login is handled by the app (NextAuth + GitHub), not by Cloudflare Access, so no Zero Trust plan or payment method is involved.

## The tunnel `quire-pi`

Created once in the Zero Trust dashboard (Networks → Tunnels → Create → Cloudflared, name `quire-pi`). Its **Public Hostname** must be: subdomain `quire`, domain `ezragubbay.com`, service `HTTP` → `app:3000` (`app` resolves inside the compose network). The dashboard creates the DNS record.

## Token without the dashboard

Any machine holding the account's origin certificate (`~/.cloudflared/cert.pem`, created by `cloudflared tunnel login`) can read the token from the CLI:

```sh
cloudflared tunnel --origincert ~/.cloudflared/cert.pem token quire-pi
```

Put it in `/srv/quire/.env` as `CF_TUNNEL_TOKEN=` with `COMPOSE_PROFILES=tunnel`. The old Pi (`ssh raspberry-pi`) has that certificate.

## Checks

- `docker compose logs cloudflared` should show `Registered tunnel connection` lines.
- `cloudflared tunnel --origincert ~/.cloudflared/cert.pem info quire-pi` lists active connections.
