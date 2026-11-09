// Pick which real, installed browser to drive for the Lemida sign-in. We need a genuine Chromium-family
// browser (its honest, aged, complete fingerprint is what clears Lemida's bot-detection — Electron's own
// embedded Chromium does not, see brave-login.ts). This is the desktop port of the agent's which-browser.js,
// trimmed to what we use: resolve to an on-disk `executablePath` we can spawn. No Playwright channels — we
// launch the binary ourselves and talk CDP to it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** macOS bundle id → app executable, for the Chromium-family browsers we can drive. */
const MAC_EXE: Record<string, string> = {
  'com.brave.browser': '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'com.brave.browser.beta': '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
  'com.google.chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'com.google.chrome.canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  'com.microsoft.edgemac': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'com.vivaldi.vivaldi': '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  'company.thebrowser.browser': '/Applications/Arc.app/Contents/MacOS/Arc',
  'org.chromium.chromium': '/Applications/Chromium.app/Contents/MacOS/Chromium',
};

/** Linux: common Chromium-family binaries by friendly name. */
const LINUX_EXE: Record<string, string[]> = {
  brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
  edge: ['/usr/bin/microsoft-edge'],
};

/** macOS path for Brave, used by the default/fallback resolution below. */
const BRAVE_MAC = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

/** Friendly names accepted in LEMIDA_BROWSER → a macOS executable path. */
const NAMED: Record<string, string> = {
  brave: BRAVE_MAC,
  'brave-beta': '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  vivaldi: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  arc: '/Applications/Arc.app/Contents/MacOS/Arc',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
};

export interface BrowserTarget {
  /** Absolute path to the browser binary to spawn, or undefined if nothing drivable was found. */
  executablePath?: string;
  /** Human label for logs / error messages. */
  name: string;
}

function firstExisting(paths: string[]): string {
  return paths.find((p) => existsSync(p)) ?? '';
}

/** The macOS default browser's bundle id (lowercased), from LaunchServices. '' if it can't be read. */
function macDefaultBundleId(): string {
  try {
    const plist = execFileSync(
      'plutil',
      [
        '-convert',
        'json',
        '-o',
        '-',
        `${process.env.HOME}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`,
      ],
      { encoding: 'utf8' },
    );
    const data = JSON.parse(plist) as { LSHandlers?: Array<Record<string, string>> };
    const handlers = Array.isArray(data.LSHandlers) ? data.LSHandlers : [];
    const h =
      handlers.find((x) => x.LSHandlerURLScheme === 'https') ??
      handlers.find((x) => x.LSHandlerURLScheme === 'http');
    return (h?.LSHandlerRoleAll ?? '').toLowerCase();
  } catch {
    return '';
  }
}

const exe = (path: string, name: string): BrowserTarget =>
  path && existsSync(path) ? { executablePath: path, name } : { name: `${name} (not found at ${path})` };

/**
 * Resolve the browser to drive. Order: an explicit pick (LEMIDA_BROWSER — a friendly name or an absolute
 * path) → the OS default browser if it is Chromium-family → Brave, the browser Ezra uses, as a last resort.
 * Returns `{ executablePath }` when something drivable was found, else just a `name` explaining the miss.
 */
export function resolveBrowser(pick?: string): BrowserTarget {
  const want = (pick ?? '').trim().toLowerCase();

  if (want) {
    if (want.startsWith('/')) return exe(want, want);
    const named = NAMED[want];
    if (named) return exe(named, want);
    const linux = LINUX_EXE[want];
    if (process.platform === 'linux' && linux) return exe(firstExisting(linux), want);
    return { name: `unknown browser "${want}" (set LEMIDA_BROWSER to brave/chrome/edge or a full path)` };
  }

  if (process.platform === 'darwin') {
    const id = macDefaultBundleId();
    const defaultExe = MAC_EXE[id];
    if (defaultExe && existsSync(defaultExe)) return { executablePath: defaultExe, name: id };
    // Default isn't a drivable Chromium (Safari/Firefox, or unreadable): fall back to Brave if installed.
    if (existsSync(BRAVE_MAC)) return { executablePath: BRAVE_MAC, name: 'brave' };
    return { name: 'no Chromium-family browser found (install Brave or Chrome, or set LEMIDA_BROWSER)' };
  }

  if (process.platform === 'linux') {
    for (const name of ['brave', 'chrome', 'chromium', 'edge']) {
      const p = firstExisting(LINUX_EXE[name] ?? []);
      if (p) return { executablePath: p, name };
    }
  }
  return { name: 'no Chromium-family browser found (set LEMIDA_BROWSER to a full path)' };
}
