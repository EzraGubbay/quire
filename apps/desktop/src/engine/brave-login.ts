// Sign in to Lemida through the user's real browser (Brave by default), not Electron's embedded Chromium.
//
// Why: Lemida sits behind bot-detection (PerimeterX/Imperva — the __uzm*/jsbd fingerprinting probes seen in
// the network log). It fingerprints the whole browser environment, not just the engine, and Electron's
// embedded Chromium presents a synthetic, incomplete fingerprint (hollow window.chrome, a UA we had to
// override that then disagrees with the client hints, a virgin profile with no clearance cookies). So the
// Microsoft OAuth would succeed but Moodle's callback bounced to the guest front page without a session.
// A genuine, installed browser has a consistent, complete, aged fingerprint the bot layer accepts — exactly
// what the original Playwright agent relied on. We launch the real browser on its OWN dedicated profile dir
// (not the user's everyday one, which macOS TCC protects anyway), let the user sign in by hand, then read the
// resulting Lemida cookies straight out of it over CDP — decrypted by the browser, so no Keychain, no SQLite,
// no Full Disk Access. Those cookies are then injected into Electron's persist:lemida session for sync.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CdpClient } from './cdp';
import { decideLoggedIn, isAuthWall, type LoginSignals } from './moodle';
import { resolveBrowser } from './which-browser';

/** Shape accepted by Electron's `session.cookies.set`, which is where these end up (see lemida-session). */
export interface HarvestedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since epoch; omitted for a session cookie. */
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/** A cookie as CDP's Network/Storage domain reports it (the fields we read). */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expires?: number; // seconds; -1 for a session cookie
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface HarvestResult {
  status: 'valid' | 'unknown';
  cookies: HarvestedCookie[];
  /** Human label of the browser used, for logs. */
  browser: string;
}

export interface HarvestOptions {
  loginUrl: string;
  /** Dedicated profile dir for the spawned browser (NOT the user's everyday profile). */
  profileDir: string;
  timeoutMs: number;
  /** Called on each poll while waiting, to keep the panel's "agent online" fresh during a long login. */
  onHeartbeat?: () => void;
  /** Overrides LEMIDA_BROWSER / default-browser resolution (mainly for tests). */
  browser?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Keep this in step with lemida-session's isLoggedIn snippet: the authoritative marker is Moodle's
// userloggedin/notloggedin <body> class; logout-link / avatar are fallbacks for themes that omit it.
const SIGNALS_JS = `(() => ({
  bodyClass: document.body ? document.body.className : '',
  hasLogout: !!document.querySelector('a[href*="/login/logout.php"]'),
  hasLogin: !!document.querySelector('a[href*="/login/index.php"]'),
  hasAvatar: !!document.querySelector('.usermenu .userbutton, .userpicture, img.userpicture, [data-region="user-menu-toggle"]'),
}))()`;

// --- pure helpers (unit-tested in scripts/smoke-parser.cjs) ----------------------------------------
/** Map CDP's SameSite spelling to Electron's. Absent → 'unspecified' (Electron's "not set" value). */
export function mapSameSite(s?: string): HarvestedCookie['sameSite'] {
  switch (s) {
    case 'Strict':
      return 'strict';
    case 'Lax':
      return 'lax';
    case 'None':
      return 'no_restriction';
    default:
      return 'unspecified';
  }
}

/**
 * Keep only the Lemida/BIU cookies (never the whole cookie store) and map them to Electron's cookie shape.
 * Session cookies (no real expiry) drop `expirationDate` so Electron stores them as session cookies too.
 */
export function normalizeCdpCookies(cookies: CdpCookie[]): HarvestedCookie[] {
  const out: HarvestedCookie[] = [];
  for (const c of cookies) {
    const host = String(c.domain ?? '').replace(/^\./, '');
    if (!host.endsWith('biu.ac.il')) continue;
    const persistent = c.session !== true && typeof c.expires === 'number' && c.expires > 0;
    out.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: mapSameSite(c.sameSite),
      ...(persistent ? { expirationDate: c.expires } : {}),
    });
  }
  return out;
}

/** Parse Chromium's DevToolsActivePort file: line 1 is the port, line 2 the browser WS path. */
export function parseDevToolsActivePort(raw: string): { port: number; wsPath: string } | null {
  const lines = raw.split('\n');
  const port = Number((lines[0] ?? '').trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, wsPath: (lines[1] ?? '').trim() };
}

// --- the CDP dance ---------------------------------------------------------------------------------
async function waitForDebugPort(
  profileDir: string,
  deadline: number,
): Promise<{ port: number; wsPath: string } | null> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    try {
      const parsed = parseDevToolsActivePort(await readFile(file, 'utf8'));
      if (parsed) return parsed;
    } catch {
      // not written yet
    }
    await sleep(200);
  }
  return null;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** Is the signed-in Lemida page currently showing? Attaches to the tab and reads Moodle's login signals. */
async function isLoggedIn(client: CdpClient): Promise<boolean> {
  const { targetInfos } = (await client.send('Target.getTargets')) as { targetInfos: TargetInfo[] };
  const page = (targetInfos ?? []).find(
    (t) => t.type === 'page' && /lemida\.biu\.ac\.il/i.test(t.url) && !isAuthWall(t.url),
  );
  if (!page) return false; // still on the Microsoft OAuth hop, or a blank tab
  const { sessionId } = (await client.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })) as { sessionId: string };
  try {
    const res = (await client.send(
      'Runtime.evaluate',
      { expression: SIGNALS_JS, returnByValue: true },
      sessionId,
    )) as { result?: { value?: LoginSignals } };
    const signals = res.result?.value;
    return signals ? decideLoggedIn(page.url, signals) : false;
  } catch {
    return false; // navigated mid-evaluate (a 365 redirect) — treat as not-yet
  } finally {
    await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function readLemidaCookies(client: CdpClient): Promise<HarvestedCookie[]> {
  const { cookies } = (await client.send('Storage.getCookies')) as { cookies?: CdpCookie[] };
  return normalizeCdpCookies(cookies ?? []);
}

/**
 * Launch the real browser at the Lemida sign-in, wait for a confirmed-signed-in Lemida page (or timeout),
 * and return the Lemida/BIU cookies it holds. The browser runs on `profileDir` and is torn down on return.
 */
export async function harvestLemidaSession(opts: HarvestOptions): Promise<HarvestResult> {
  const target = resolveBrowser(opts.browser ?? process.env.LEMIDA_BROWSER);
  if (!target.executablePath) throw new Error(`Cannot sign in to Lemida: ${target.name}`);

  await mkdir(opts.profileDir, { recursive: true });
  // A stale DevToolsActivePort from a previous run would point us at a dead port; clear it before launch.
  await rm(path.join(opts.profileDir, 'DevToolsActivePort'), { force: true }).catch(() => {});

  const child = spawn(
    target.executablePath,
    [
      `--user-data-dir=${opts.profileDir}`,
      '--remote-debugging-port=0', // ephemeral; Chromium writes the chosen port to DevToolsActivePort
      '--no-first-run',
      '--no-default-browser-check',
      '--no-service-autorun',
      opts.loginUrl,
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });

  const deadline = Date.now() + opts.timeoutMs;
  try {
    const dbg = await waitForDebugPort(opts.profileDir, Math.min(deadline, Date.now() + 25_000));
    if (!dbg || exited) return { status: 'unknown', cookies: [], browser: target.name };

    const wsUrl = dbg.wsPath.startsWith('/')
      ? `ws://127.0.0.1:${dbg.port}${dbg.wsPath}`
      : `ws://127.0.0.1:${dbg.port}/devtools/browser`;
    const client = await CdpClient.connect(wsUrl);
    try {
      while (Date.now() < deadline && !exited) {
        if (await isLoggedIn(client).catch(() => false)) {
          const cookies = await readLemidaCookies(client);
          return { status: 'valid', cookies, browser: target.name };
        }
        opts.onHeartbeat?.();
        await sleep(2000);
      }
      return { status: 'unknown', cookies: [], browser: target.name };
    } finally {
      client.close();
    }
  } finally {
    if (!exited) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }
}
