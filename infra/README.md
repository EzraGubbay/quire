# Quire infrastructure

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build of the Next.js app (standalone output), arm64 + amd64 |
| `compose.yml` | Production stack on the Pi: `db` (Postgres 17 + pgvector), `app`, `cloudflared`, `backup` |
| `compose.dev.yml` | Local Postgres for development |
| `.env.example` | Variables the production stack needs; copy to `/srv/quire/.env` |
| `pi/bootstrap.sh` | One-time OS setup on a fresh Raspberry Pi OS Lite (Docker, firewall, upgrades) |
| `pi/install-runner.sh` | Registers the GitHub Actions self-hosted runner as a service |
| `cloudflared/README.md` | Tunnel + Access dashboard steps |
| `backup/` | Nightly `pg_dump` + `rclone` sync of dumps and files to Backblaze B2, plus `restore.sh` |

## First deployment, in order

1. `ssh -t researchpi 'sudo bash -s' < infra/pi/bootstrap.sh` (asks for your sudo password), then reconnect.
2. Follow `cloudflared/README.md`; fill `/srv/quire/.env` from `.env.example`.
3. `scp infra/compose.yml infra/backup/* researchpi:/srv/quire/` is done by the deploy workflow, but for the very first run: `RUNNER_TOKEN=$(gh api -X POST repos/ezragubbay/quire/actions/runners/registration-token -q .token) ssh researchpi 'RUNNER_TOKEN='"$RUNNER_TOKEN"' bash -s' < infra/pi/install-runner.sh`.
4. Push to `main`. The `deploy` workflow builds the image, and the runner on the Pi pulls it, runs migrations, and starts the stack.

## Day-to-day

- Logs: `ssh researchpi 'cd /srv/quire && docker compose logs -f app'`
- Manual backup: `docker compose exec backup backup.sh`
- Restore: `docker compose exec backup restore.sh`
- Roll back: set `QUIRE_IMAGE=ghcr.io/ezragubbay/quire:<previous sha>` in `.env` and `docker compose up -d app`
