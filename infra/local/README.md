# Local hosting (laptop) and moving courses to the Pi

`infra/compose.local.yml` runs the same image the Pi runs, plus Postgres and Gotenberg, with
`restart: unless-stopped`: once Docker Desktop starts at login, Quire is up at http://localhost:3000 with
nothing in a terminal. On the same Wi-Fi an iPad opens `http://<laptop-ip>:3000`.

All data lives in **one folder**, `~/Desktop/current-uni/quire-local` (override with `QUIRE_LOCAL_DIR`):

| Path | What |
|---|---|
| `files/` | uploads: decks (`.pptx` + PDF rendering), slide images, test PDFs, homework files |
| `pgdata/` | the Postgres data directory (do not edit; back it up with the folder) |
| `dumps/<timestamp>/` | exports from `pnpm local:export`, ready to migrate |
| `local.env` | `OPENAI_API_KEY`, `AI_MOCK` |

## Commands (repo root)

```sh
pnpm local:up        # build the image from the working tree and start everything (first run: a few minutes)
pnpm local:logs      # follow the app log
pnpm local:down      # stop (data stays in the folder)
pnpm local:export    # courses → dumps/<timestamp>/ (CSV + import.sql + files)
```

After pulling new code, `pnpm local:up` again rebuilds the image; migrations run at boot.

## Migrating to the deployed instance

1. Deploy the same commit to the Pi first (both sides must be on the same schema).
2. `pnpm local:export` → note the `dumps/<timestamp>` path it prints.
3. On a network that reaches the Pi: `infra/local/migrate-to-pi.sh ~/Desktop/current-uni/quire-local/dumps/<timestamp>`.
   It backs up the Pi (database + files, also copied to `backups/` here), dry-runs the import against the live
   database, imports the course rows (research projects untouched) and files, then checks every count against the
   export's `manifest.txt` and that every stored file exists.
4. Open each course on the Pi and click **Index missing items** in its settings (embeddings are not exported).

The import inserts rows with their original ids, so running the same export twice fails on duplicates rather than
doubling anything. To re-import, delete the course on the Pi first.

## Notes

- `AUTH_MODE=none` locally: anyone on your Wi-Fi who knows the address can open it. Keep it to trusted networks.
- The stack is separate from the dev one (`infra/compose.dev.yml`), which keeps its own database for `pnpm dev`.
