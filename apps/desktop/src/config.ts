// Desktop configuration. The only setting today is which Quire to load. Resolution order:
//   QUIRE_URL env  →  <userData>/config.json  →  the Pi default.
// On first run we write the resolved value to config.json so there's a file to edit by hand.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const DEFAULT_QUIRE_URL = 'https://quire.ezragubbay.com';

export interface DesktopConfig {
  /** Base URL of the Quire instance the main window loads (no trailing slash). */
  quireUrl: string;
  /** Minutes between automatic Lemida syncs while signed in; 0 disables. Env LEMIDA_AUTO_SYNC_MINUTES overrides. */
  autoSyncMinutes: number;
}

const DEFAULT_AUTO_SYNC_MINUTES = 120;

/** A usable minutes value is a finite number >= 0; anything else falls through to the next source. */
function minutesOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): DesktopConfig {
  const file = configPath();
  let stored: Partial<DesktopConfig> = {};
  try {
    if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopConfig>;
  } catch {
    // Malformed/unreadable config — fall back to env + default.
  }
  const envUrl = process.env.QUIRE_URL?.replace(/\/+$/, '') || undefined;
  const quireUrl = (envUrl ?? stored.quireUrl ?? DEFAULT_QUIRE_URL).replace(/\/+$/, '');
  // Seed a hand-editable config file on first run — but NEVER from a QUIRE_URL override, so a one-off dev
  // URL (e.g. localhost) can't get baked into the packaged app's persistent config.
  if (!existsSync(file) && !envUrl) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ quireUrl }, null, 2)}\n`);
    } catch {
      // Non-fatal: we still have the resolved value in memory for this run.
    }
  }
  const autoSyncMinutes =
    minutesOrUndefined(process.env.LEMIDA_AUTO_SYNC_MINUTES) ??
    minutesOrUndefined(stored.autoSyncMinutes) ??
    DEFAULT_AUTO_SYNC_MINUTES;
  return { quireUrl, autoSyncMinutes };
}
