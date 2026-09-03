# Quire infrastructure

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build of the Next.js app (standalone output), arm64 + amd64 |
| `compose.yml` | Production stack on the Pi: `db` (Postgres 17 + pgvector), `app`, `cloudflared`, `backup` |
| `compose.dev.yml` | Local Postgres for development |
| `.env.example` | Variables the production stack needs; copy to `/srv/quire/.env` |
| `pi/bootstrap.sh` | One-time OS setup on a fresh Raspberry Pi OS Lite (Docker, firewall, upgrades) |
| `pi/install-runner.sh` | Registers the GitHub Actions self-hosted runner as a service |
| `cloudflared/README.md` | Tunnel setup and how to read its token from the CLI |
| `backup/` | Nightly `pg_dump` + `rclone` sync of dumps and files to Backblaze B2, plus `restore.sh` |

## First deployment, in order

1. `scp infra/pi/*.sh researchpi:~/` then `ssh -t researchpi 'sudo ./bootstrap.sh'` (asks for your sudo password; piping the script over stdin would stop sudo from prompting), then reconnect.
2. Follow `cloudflared/README.md` for the tunnel token; create a GitHub OAuth app (callback `https://quire.ezragubbay.com/api/auth/callback/github`); fill `/srv/quire/.env` from `.env.example`.
3. Register the runner: `ssh -t researchpi "RUNNER_TOKEN=$(gh api -X POST repos/EzraGubbay/quire/actions/runners/registration-token -q .token) ./install-runner.sh"` (sudo prompts once for the service install).
4. Push to `main`. The `deploy` workflow builds the image, and the runner on the Pi pulls it, runs migrations, and starts the stack.

## Day-to-day

- Logs: `ssh researchpi 'cd /srv/quire && docker compose logs -f app'`
- Manual backup: `docker compose exec backup backup.sh`
- Restore: `docker compose exec backup restore.sh`
- Roll back: set `QUIRE_IMAGE=ghcr.io/ezragubbay/quire:<previous sha>` in `.env` and `docker compose up -d app`
