# desktop

The Quire desktop shell: an Electron app whose main window loads the Pi-hosted Quire
(`https://quire.ezragubbay.com`) over a **persistent** session, so you sign in to GitHub once and it
sticks across launches. It's a thin wrapper — nothing about the web app or the Pi changes.

Its reason to exist is the one thing a web page can't do: host an **embedded Lemida sign-in** whose
session cookies the app can read and reuse for headless course-file sync. That engine lands in
`src/engine` (Workstream C); this package is currently just the shell plus the wiring points for it
(`signInToLemida()` IPC, the **Lemida → Sign in to Lemida…** menu item, and a `lemida:status` channel).

## Develop

```bash
pnpm --filter desktop dev     # compiles TS to dist/ and launches Electron
```

The first launch may download the Electron binary (allowed via `onlyBuiltDependencies` in
`pnpm-workspace.yaml`).

## Configure which Quire it loads

Resolution order: `QUIRE_URL` env → `<userData>/config.json` → the Pi default. On first run the resolved
value is written to `config.json` so there's a file to edit. On macOS that's:

```
~/Library/Application Support/Quire/config.json
```

```bash
QUIRE_URL=http://localhost:3000 pnpm --filter desktop dev   # point at a local stack instead
```

## Package (unsigned)

```bash
pnpm --filter desktop dist    # → release/*.dmg and *.zip, UNSIGNED
```

Unsigned builds: open the `.app` the first time via right-click → **Open** to get past Gatekeeper.
Signing, notarization, and auto-update are intentionally out of scope for this pass.

## Build layout

- `src/main.ts` — app entry: window, menu, external-link handling, Lemida IPC stub.
- `src/preload.ts` — the `window.quireDesktop` bridge (contextIsolation on, nodeIntegration off).
- `src/config.ts` — `QUIRE_URL` / `config.json` resolution.
- TypeScript compiles to **CommonJS** in `dist/` (`main` → `dist/main.js`).
