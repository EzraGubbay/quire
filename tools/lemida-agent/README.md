# lemida-agent

A small companion that pulls your course files from **Lemida** (BIU's Moodle) into Quire.

It runs **on your Mac**, not on the Pi, because the whole point is that it reuses the Lemida
session **you** sign into by hand. It never types your password, never touches a bot‑check or
CAPTCHA, and never pretends to be the official Moodle app. Everything it does — open a course page,
download a file you can already see — is something you could do yourself in your browser. If the
session ever lapses, it stops and asks you to sign in again.

## How it fits together

```
You (sign in once a day)        Quire on the Pi
      │                               ▲
      ▼                               │ POST /api/projects/<course>/lemida/import
  Chrome profile  ◄── lemida-agent ───┤ GET  /api/lemida/commands   (sign in / sync)
  (session cookies)                   │ POST /api/lemida/state       (session + heartbeat)
                                      │
                               Quire → Courses → "Lemida sync" panel
```

The panel is where you link each Quire course to its Lemida page, press **Sign in to Lemida** /
**Sync now**, and sort anything the automatic rules weren't sure about.

## Setup (once)

```bash
cd tools/lemida-agent
npm install
npm run setup            # downloads the Chromium Playwright uses
cp .env.example .env     # then edit .env: QUIRE_BASE_URL and QUIRE_API_KEY
```

`QUIRE_API_KEY` is the same key the Pi uses. Read it from the Pi; don't paste it anywhere public.

## Use

```bash
npm start                # the loop: handles panel commands + hourly session check
npm run login            # open a window to sign in to Lemida by hand (one-off)
npm run probe            # check the session once
npm run sync             # crawl mapped courses once and import new files
npm run sync -- --full   # re-scan everything, ignoring the local seen-cache
npm run parse -- fixtures/course.html   # dry-run the Moodle parser (no network/browser)
npm test                 # parser unit tests
```

Typical first run: `npm run login`, finish signing in (including the 365 step and any bot check) in
the window that opens, then `npm run sync`. After that, `npm start` keeps it going and the panel's
buttons drive it.

## Run it in the background (launchd)

See `launchd/com.quire.lemida-agent.plist`. Edit the paths, then:

```bash
cp launchd/com.quire.lemida-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.quire.lemida-agent.plist
```

## What it classifies (Phase 1, deterministic)

File names, the Moodle section heading, and the activity type decide where each file lands
(lecture / recitation / homework / practice exam / course material). Anything it isn't sure about
goes to the course's Documents and shows up in the panel's **Needs review** list for a one‑click fix.
Those decisions and your corrections are recorded in Quire for the Phase‑2 learning pass.

## Not here

No credential entry, no bot‑check solving, no API‑token forging, no mobile‑app impersonation. If a
real signed‑in session still gets blocked, the fix is to ask BIU for Moodle web‑services access — not
to work around the block.
