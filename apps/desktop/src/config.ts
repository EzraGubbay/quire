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
  const quireUrl = (process.env.QUIRE_URL ?? stored.quireUrl ?? DEFAULT_QUIRE_URL).replace(/\/+$/, '');
  if (!existsSync(file)) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ quireUrl }, null, 2)}\n`);
    } catch {
      // Non-fatal: we still have the resolved value in memory for this run.
    }
  }
  return { quireUrl };
}
