// Electron reimplementation of the agent's Playwright `browser.js`. All Lemida browsing happens on a
// persistent `persist:lemida` session partition, separate from the main window's default session. Nothing
// here types credentials or passes a login/bot page — if it lands on one, it reports the session expired.
//
// Guardrails preserved from the original: SessionExpired on any auth-wall / enrolment landing, and the
// honest desktop UA (the partition's UA is set to a plain Chrome string so no "Electron" token leaks).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, type Session, session, type WebContents } from 'electron';
import {
  decideLoggedIn,
  filenameFrom,
  isAuthWall,
  type LoginSignals,
  parseMoodleCourse,
  parsePluginfileLinks,
  parseResourceWorkaround,
  type Resource,
} from './moodle';

export type SessionStatus = 'valid' | 'expired' | 'unknown';

export class SessionExpired extends Error {
  constructor(url?: string) {
    super(`Lemida session expired (hit ${url ?? 'a login/bot page'})`);
    this.name = 'SessionExpired';
  }
}

export interface SyncCourse {
  slug: string;
  lemidaUrl: string;
  mappingId?: string;
  label?: string;
}

export interface Download {
  name: string;
  bytes: ArrayBuffer;
  contentType: string;
  sourceUrl: string;
}

export type OnFile = (download: Download, resource: Resource) => Promise<void>;

export interface SyncStats {
  resources: number;
  downloaded: number;
  skipped: number;
}

/** The module types we pull files from; anything else (url, page, quiz, …) is left alone. */
const FILE_MODULES = new Set(['mod_resource', 'mod_folder', 'mod_assign']);

const PARTITION = 'persist:lemida';
const LEMIDA = {
  loginUrl:
    process.env.LEMIDA_LOGIN_URL ?? 'https://lemida.biu.ac.il/auth/multioauth/login.php?userType=student',
  homeUrl: process.env.LEMIDA_HOME_URL ?? 'https://lemida.biu.ac.il/my/',
  loginTimeoutMs: Number(process.env.LEMIDA_LOGIN_TIMEOUT_MS ?? 300_000),
  // Honest, ordinary desktop UA; we never impersonate the Moodle mobile app, and we strip Electron's own
  // UA token (which would otherwise advertise automation).
  userAgent:
    process.env.LEMIDA_USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let uaSet = false;
/** The Lemida partition session, with the plain UA applied once. */
function lemidaSession(): Session {
  const ses = session.fromPartition(PARTITION);
  if (!uaSet) {
    ses.setUserAgent(LEMIDA.userAgent);
    uaSet = true;
  }
  return ses;
}

// --- cookie save/restore ---------------------------------------------------------------------------
// Moodle's login cookie is a *session* cookie that Chromium (and so Electron) drops when the partition
// is torn down between app runs, so we persist all cookies after a confirmed-valid session and re-inject
// them on startup — exactly as the agent did with Playwright's storageState.
function cookieFile(): string {
  return path.join(app.getPath('userData'), 'lemida-cookies.json');
}

function cookieUrl(c: Electron.Cookie): string {
  const host = (c.domain ?? '').replace(/^\./, '');
  const scheme = c.secure ? 'https' : 'http';
  return `${scheme}://${host}${c.path ?? '/'}`;
}

export async function restoreCookies(): Promise<void> {
  const ses = lemidaSession();
  let raw: string;
  try {
    raw = await readFile(cookieFile(), 'utf8');
  } catch {
    return; // nothing saved yet — rely on whatever the persistent partition still holds
  }
  let parsed: { cookies?: Electron.Cookie[] };
  try {
    parsed = JSON.parse(raw) as { cookies?: Electron.Cookie[] };
  } catch {
    return;
  }
  for (const c of parsed.cookies ?? []) {
    try {
      await ses.cookies.set({
        url: cookieUrl(c),
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite,
      });
    } catch {
      // A single malformed cookie shouldn't sink the restore.
    }
  }
}

export async function saveCookies(): Promise<void> {
  const ses = lemidaSession();
  const cookies = await ses.cookies.get({});
  await writeFile(cookieFile(), JSON.stringify({ cookies }, null, 2)).catch(() => {});
}

// --- navigation helpers ----------------------------------------------------------------------------
/** Load a URL and resolve once the page has gone quiet (emulates Playwright's `networkidle`). */
function navigate(win: BrowserWindow, url: string, settleMs = 1200, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    const wc = win.webContents;
    let settle: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wc.removeListener('did-stop-loading', onStop);
      if (settle) clearTimeout(settle);
      clearTimeout(hard);
      resolve(win.isDestroyed() ? url : wc.getURL());
    };
    const onStop = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(finish, settleMs);
    };
    wc.on('did-stop-loading', onStop);
    const hard = setTimeout(finish, timeoutMs);
    // Redirect chains (365 OAuth) can reject loadURL with ERR_ABORTED; ignore and rely on did-stop-loading.
    wc.loadURL(url).catch(() => {});
  });
}

async function getHtml(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript('document.documentElement.outerHTML', true)) as string;
}

async function isLoggedIn(wc: WebContents): Promise<boolean> {
  try {
    const url = wc.getURL();
    if (isAuthWall(url)) return false;
    // Gather the signals Moodle exposes and let the pure `decideLoggedIn` judge them. The authoritative one
    // is the `userloggedin` / `notloggedin` class Moodle puts on <body>; the logout-link / avatar checks are
    // fallbacks for a theme that omits it. (Keying on the logout link alone used to miss real sign-ins.)
    const signals = (await wc.executeJavaScript(
      `(() => ({
        bodyClass: document.body ? document.body.className : '',
        hasLogout: !!document.querySelector('a[href*="/login/logout.php"]'),
        hasLogin: !!document.querySelector('a[href*="/login/index.php"]'),
        hasAvatar: !!document.querySelector('.usermenu .userbutton, .userpicture, img.userpicture, [data-region="user-menu-toggle"]'),
      }))()`,
      true,
    )) as LoginSignals;
    return decideLoggedIn(url, signals);
  } catch {
    // Page navigated mid-check (e.g. a 365 redirect) — treat as not-yet.
    return false;
  }
}

function hiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      images: false, // we only read the DOM / download files; skip images for speed
    },
  });
}

// --- the three operations --------------------------------------------------------------------------
/**
 * Open a visible window at the Lemida login so you can sign in by hand (incl. 365 / any bot check).
 * Returns the session status once you're in, or when the window times out / is closed.
 */
// Only one sign-in window at a time. A second request while one is open (an impatient re-click when the
// panel looked stuck) should surface the existing window, not stack another on the same partition.
let activeLoginWin: BrowserWindow | null = null;

export async function openLogin(opts: { onHeartbeat?: () => void } = {}): Promise<SessionStatus> {
  if (activeLoginWin && !activeLoginWin.isDestroyed()) {
    activeLoginWin.show();
    activeLoginWin.focus();
    return 'unknown';
  }
  await restoreCookies(); // a still-valid session skips the manual step
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'Sign in to Lemida',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  activeLoginWin = win;
  let closed = false;
  win.on('closed', () => {
    closed = true;
  });
  try {
    await navigate(win, LEMIDA.loginUrl);
    const deadline = Date.now() + LEMIDA.loginTimeoutMs;
    while (Date.now() < deadline && !closed && !win.isDestroyed()) {
      if (await isLoggedIn(win.webContents)) {
        await saveCookies(); // capture the session cookie while it's live
        return 'valid';
      }
      // Keep the agent's heartbeat fresh while the user is signing in, so the panel keeps showing "agent
      // online" instead of going stale during the (possibly minute-long) 365 login.
      opts.onHeartbeat?.();
      await sleep(2000);
    }
    if (!closed && !win.isDestroyed() && (await isLoggedIn(win.webContents))) {
      await saveCookies();
      return 'valid';
    }
    return 'unknown';
  } finally {
    if (!win.isDestroyed()) win.close();
    activeLoginWin = null;
  }
}

/** Load the home page in a hidden window and report whether the reused session is still signed in. */
export async function probe(): Promise<SessionStatus> {
  await restoreCookies();
  const win = hiddenWindow();
  try {
    await navigate(win, LEMIDA.homeUrl);
    if (win.isDestroyed()) return 'unknown';
    const ok = await isLoggedIn(win.webContents);
    if (ok) await saveCookies(); // refresh the on-disk copy so the next launch restores a live session
    return ok ? 'valid' : 'expired';
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

interface FetchHead {
  finalUrl: string;
  contentType: string;
  disposition: string;
  resp: Response;
}

async function fetchBytes(ses: Session, url: string): Promise<FetchHead | null> {
  const resp = await ses.fetch(url, { headers: { 'user-agent': LEMIDA.userAgent } });
  const finalUrl = resp.url;
  if (isAuthWall(finalUrl)) throw new SessionExpired(finalUrl);
  if (!resp.ok) return null;
  return {
    finalUrl,
    contentType: resp.headers.get('content-type') ?? '',
    disposition: resp.headers.get('content-disposition') ?? '',
    resp,
  };
}

/** Download the actual file(s) behind one activity (resource = 1 file; folder/assign = possibly several). */
async function collectDownloads(ses: Session, resource: Resource): Promise<Download[]> {
  const out: Download[] = [];
  const head = await fetchBytes(ses, resource.href);
  if (!head) return out;
  const isHtml = /text\/html/i.test(head.contentType);

  if (resource.moduleType === 'mod_resource' && !isHtml) {
    out.push({
      name: filenameFrom(head.finalUrl, head.disposition),
      bytes: await head.resp.arrayBuffer(),
      contentType: head.contentType,
      sourceUrl: head.finalUrl,
    });
    return out;
  }

  const html = await head.resp.text();
  const links =
    resource.moduleType === 'mod_resource'
      ? [parseResourceWorkaround(html, head.finalUrl)].filter(Boolean)
      : parsePluginfileLinks(html, head.finalUrl);

  for (const link of links) {
    const file = await fetchBytes(ses, link);
    if (!file) continue;
    out.push({
      name: filenameFrom(file.finalUrl, file.disposition),
      bytes: await file.resp.arrayBuffer(),
      contentType: file.contentType,
      sourceUrl: file.finalUrl,
    });
  }
  return out;
}

/**
 * The file activities on a course page, following Moodle 4.5 "subsections" (delegated sections whose
 * activities live on their own /mod/subsection/ page). One level of nesting is expanded.
 */
async function gatherResources(win: BrowserWindow): Promise<Resource[]> {
  const top = parseMoodleCourse(await getHtml(win), win.webContents.getURL());
  const files = top.filter((r) => FILE_MODULES.has(r.moduleType));
  // The course-index merge in parseMoodleCourse normally already covers subsection files; only crawl
  // subsection pages when it didn't (an older layout with no course index).
  if (files.length === 0) {
    for (const sub of top.filter((r) => r.moduleType === 'mod_subsection')) {
      const landed = await navigate(win, sub.href);
      if (isAuthWall(landed)) throw new SessionExpired(landed);
      for (const r of parseMoodleCourse(await getHtml(win), landed)) {
        if (FILE_MODULES.has(r.moduleType)) files.push({ ...r, sectionTitle: r.sectionTitle || sub.name });
      }
    }
  }
  const seen = new Set<string>();
  const deduped: Resource[] = [];
  for (const r of files) {
    if (seen.has(r.href)) continue;
    seen.add(r.href);
    deduped.push(r);
  }
  return deduped;
}

/** Crawl one mapped course and hand each new file to `onFile`. `seen` holds hrefs from earlier runs. */
export async function syncCourse(
  course: SyncCourse,
  onFile: OnFile,
  { seen = new Set<string>(), full = false }: { seen?: Set<string>; full?: boolean } = {},
): Promise<SyncStats> {
  await restoreCookies();
  const ses = lemidaSession();
  const win = hiddenWindow();
  const stats: SyncStats = { resources: 0, downloaded: 0, skipped: 0 };
  try {
    const landed = await navigate(win, course.lemidaUrl);
    if (isAuthWall(landed)) throw new SessionExpired(landed);
    // Not signed in as an enrolled student ⇒ Moodle sends us to the enrolment page, not the course.
    if (/\/enrol\//.test(landed)) {
      throw new SessionExpired(`${landed} (not enrolled, or signed in only as a guest — sign in again)`);
    }
    const resources = await gatherResources(win);
    stats.resources = resources.length;
    for (const resource of resources) {
      if (!full && seen.has(resource.href)) {
        stats.skipped++;
        continue;
      }
      const downloads = await collectDownloads(ses, resource);
      for (const dl of downloads) {
        await onFile(dl, resource);
        stats.downloaded++;
      }
      seen.add(resource.href);
    }
    return stats;
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}
