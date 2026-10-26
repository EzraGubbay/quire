// Choose which browser Playwright drives. We want the user's own browser (e.g. Brave) rather than
// Playwright's bundled Chromium — but it must be a Chromium-family browser Playwright can drive, and it
// runs on the agent's OWN profile (not your everyday profile), so the login you do in it can be reused
// headlessly for probe/sync. Resolution order: explicit LEMIDA_BROWSER → the OS default browser → bundled.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** macOS bundle id → app executable, for the Chromium-family browsers we can drive. */
const MAC_EXE = {
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
const LINUX_EXE = {
  brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser'],
  edge: ['/usr/bin/microsoft-edge'],
};

/** Friendly names accepted in LEMIDA_BROWSER. channel:* → Playwright channel; else a mac exe path. */
const NAMED = {
  brave: MAC_EXE['com.brave.browser'],
  chrome: 'channel:chrome',
  edge: 'channel:msedge',
  vivaldi: MAC_EXE['com.vivaldi.vivaldi'],
  arc: MAC_EXE['company.thebrowser.browser'],
  chromium: 'channel:', // bundled Chromium
};

function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) ?? '';
}

/** The macOS default browser's bundle id (lowercased), from LaunchServices. '' if it can't be read. */
function macDefaultBundleId() {
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
    const data = JSON.parse(plist);
    const handlers = Array.isArray(data.LSHandlers) ? data.LSHandlers : [];
    const h =
      handlers.find((x) => x.LSHandlerURLScheme === 'https') ??
      handlers.find((x) => x.LSHandlerURLScheme === 'http');
    return (h?.LSHandlerRoleAll ?? '').toLowerCase();
  } catch {
    return '';
  }
}

const exe = (path, name) =>
  path && existsSync(path)
    ? { executablePath: path, name }
    : { name: `chromium (bundled; ${name} not found)` };

/**
 * Returns the Playwright launch target: { executablePath } or { channel } (empty => bundled Chromium),
 * plus a human `name` for logging. Non-Chromium defaults (Safari, Firefox) fall back to bundled Chromium.
 */
export function resolveBrowser(config) {
  const pick = (config.browser ?? '').trim().toLowerCase();

  if (pick) {
    if (pick.startsWith('/')) return exe(pick, pick);
    if (pick in NAMED) {
      const v = NAMED[pick];
      if (v.startsWith('channel:')) {
        const c = v.slice('channel:'.length);
        return c ? { channel: c, name: pick } : { name: 'chromium (bundled)' };
      }
      return exe(v, pick);
    }
    if (process.platform === 'linux' && pick in LINUX_EXE) return exe(firstExisting(LINUX_EXE[pick]), pick);
    // Otherwise treat it as a Playwright channel name (chrome, msedge, chrome-beta, …).
    return { channel: pick, name: pick };
  }

  if (process.platform === 'darwin') {
    const id = macDefaultBundleId();
    if (id && MAC_EXE[id] && existsSync(MAC_EXE[id])) return { executablePath: MAC_EXE[id], name: id };
    if (id) return { name: `chromium (bundled; default "${id}" is not a drivable Chromium browser)` };
  } else if (process.platform === 'linux') {
    for (const name of ['brave', 'chrome', 'chromium', 'edge']) {
      const p = firstExisting(LINUX_EXE[name]);
      if (p) return { executablePath: p, name };
    }
  }
  return { name: 'chromium (bundled)' };
}
