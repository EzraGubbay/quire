# Cloudflare Tunnel and Access for quire.ezragubbay.com

The Pi has no inbound ports. A remote-managed Cloudflare Tunnel connects out from the `cloudflared` container in `compose.yml`, and Cloudflare Access gates every request with a login page before it reaches the Pi.

## One-time setup (Zero Trust dashboard, one.dash.cloudflare.com)

1. **Networks → Tunnels → Create a tunnel** → Cloudflared → name `quire-pi`. Copy the token from the install command (the long string after `--token`). Put it in `/srv/quire/.env` as `CF_TUNNEL_TOKEN`.
2. In the tunnel's **Public hostname** tab add: subdomain `quire`, domain `ezragubbay.com`, service `HTTP` → `app:3000`. (The `cloudflared` container shares the compose network, so `app` resolves.)
3. **Access → Applications → Add an application** → Self-hosted. Name `Quire`, application domain `quire.ezragubbay.com`. Identity providers: One-time PIN (and Google if you have it set up). Session duration: 1 month.
   - Policy `Owner`: Allow, include **Emails** = your email.
   - Policy `Service tokens`: Service Auth, include **Any service token** (used by the Python client and CI health checks).
4. Open the application's **Overview** and copy the **Application Audience (AUD) Tag** → `CF_ACCESS_AUD` in `.env`. Your team domain (e.g. `https://ezragubbay.cloudflareaccess.com`) → `CF_ACCESS_TEAM_DOMAIN`.
5. **Access → Service Auth → Service Tokens → Create**: name `quire-clients`. Keep the Client ID and Client Secret; the Python client sends them as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Add the same two values as repository secrets `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` for the deploy health check.

The app verifies the `Cf-Access-Jwt-Assertion` header against `CF_ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs` with the AUD above, so a request that somehow bypasses Cloudflare is rejected.
