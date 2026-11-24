// Electron reimplementation of the agent's Playwright `browser.js`. All headless Lemida browsing (probe +
// sync) happens on a persistent `persist:lemida` session partition, separate from the main window's default
// session. Nothing here types credentials or passes a login/bot page — if it lands on one, it reports the
// session expired.
//
// Sign-in opens a visible BrowserWindow on this same partition at the Lemida login URL; the user signs in by
// hand (Microsoft 365 OAuth), and the MoodleSession cookie the callback sets is captured right here — no
// external browser. A clean-room diagnostic confirmed Electron's embedded Chromium completes the OAuth and
// receives a live session (cookie `MoodleSessionprod`, with an authenticated `sesskey`); the bot layer does
// not block it. probe()/sync() then reuse the same partition.
//
// Guardrails preserved from the original: SessionExpired on any auth-wall / enrolment landing, and the
// honest desktop UA (the partition's UA is set to a plain Chrome string so no "Electron" token leaks).
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, type Session, safeStorage, session, type WebContents } from 'electron';
import { closeHelper, openHelper } from './credential-bar';
import { waitForSignIn, withTimeout } from './lifecycle';
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
import { reconcileResources } from './reconcile';
import {
  cookiesToRestore,
  decodeCookieFile,
  desktopUserAgent,
  duplicateDomainCopies,
  encodeCookieFile,
  isHostOnly,
  isPersistable,
  lemidaHost,
  type StoredCookie,
  toSetDetails,
} from './session-policy';

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
  /** Cap on a single "am I logged in" check (see isLoggedIn). */
  checkTimeoutMs: 5_000,
  // Honest, ordinary desktop UA; we never impersonate the Moodle mobile app, and we strip Electron's own
  // UA token (which would otherwise advertise automation). The Chrome major comes from the bundled Chromium so
  // the UA agrees with the real Sec-CH-UA client hints and stays right across Electron upgrades.
  userAgent: process.env.LEMIDA_USER_AGENT ?? desktopUserAgent(process.versions.chrome),
};

export const LOGIN_TIMEOUT_MS = LEMIDA.loginTimeoutMs;
const CHECK_TIMEOUT_MS = LEMIDA.checkTimeoutMs;

// True while an interactive sign-in window is open. The engine (probe/sync, which share this partition) must
// not restore cookies or navigate during that window: injecting a stale MoodleSession or landing a hidden
// probe on a logged-out page clobbers the live cookie that holds Moodle's OAuth `state`, and the callback is
// then rejected as a guest. Exposed so the engine can also skip its passive probe while sign-in is in flight.
let loginInFlight = false;
export function isSignInInProgress(): boolean {
  return loginInFlight;
}

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

// --- cookie persistence ----------------------------------------------------------------------------
// Moodle's login cookie is a *session* cookie that Chromium (and so Electron) drops when the partition is torn
// down between app runs, so we persist it after a confirmed-valid session and re-inject it ONCE per launch
// (initSessionCookies, from engine.start). Only the Lemida host's `MoodleSession*` is persisted: Chromium
// already keeps every non-session cookie of the partition on disk, and the bot-manager / Microsoft cookies
// are not needed to reuse the session. The file is encrypted with the Keychain (safeStorage) and mode 0600;
// there is no plaintext fallback. Logs name cookies and counts only, never values.
const LEMIDA_HOST = lemidaHost(LEMIDA.homeUrl);

function cookieFile(): string {
  return path.join(app.getPath('userData'), 'lemida-cookies.enc');
}

/** The pre-hardening plaintext file; migrated then deleted at startup. */
function legacyCookieFile(): string {
  return path.join(app.getPath('userData'), 'lemida-cookies.json');
}

function cookieUrl(c: Electron.Cookie): string {
  const host = (c.domain ?? '').replace(/^\./, '');
  const scheme = c.secure ? 'https' : 'http';
  return `${scheme}://${host}${c.path ?? '/'}`;
}

/** Write encrypted bytes with owner-only permissions: tmp file (0600) + rename + chmod. */
async function writeEncrypted(text: string): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[lemida] cookies: OS encryption unavailable, not persisting the session cookie');
    return false;
  }
  const file = cookieFile();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, safeStorage.encryptString(text), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
  return true;
}

async function readSavedCookies(): Promise<StoredCookie[]> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return [];
    return decodeCookieFile(safeStorage.decryptString(await readFile(cookieFile())));
  } catch {
    return []; // nothing saved yet, or unreadable: rely on the persistent partition
  }
}

/** Persist the (persistable subset of the) live session. Called after a valid sign-in / probe. */
export async function saveCookies(): Promise<void> {
  const ses = lemidaSession();
  const live = (await ses.cookies.get({})) as StoredCookie[];
  const keep = live.filter((c) => isPersistable(c, LEMIDA_HOST));
  if (keep.length === 0) return; // never overwrite a good file with an empty one
  await writeEncrypted(encodeCookieFile(keep)).catch(() => {});
}

/**
 * Once per app launch: migrate the plaintext file, remove the duplicate domain copies an older restore created,
 * then restore saved cookies that are not already live. Never called from probe/sync/sign-in.
 */
export async function initSessionCookies(): Promise<{
  restored: string[];
  deduped: number;
  migrated: boolean;
}> {
  const ses = lemidaSession();
  let migrated = false;

  // 1. Migrate the legacy plaintext file (keep only persistable cookies), then always delete it.
  try {
    const legacy = decodeCookieFile(await readFile(legacyCookieFile(), 'utf8'));
    const keep = legacy.filter((c) => isPersistable(c, LEMIDA_HOST));
    const hasEnc = await stat(cookieFile()).then(
      () => true,
      () => false,
    );
    if (!hasEnc && keep.length > 0) await writeEncrypted(encodeCookieFile(keep));
    migrated = true;
  } catch {
    // no legacy file
  }
  if (migrated) await unlink(legacyCookieFile()).catch(() => {});

  // 2. Dedupe the partition: drop domain copies shadowing a host-only twin, re-set the host-only value.
  let live = (await ses.cookies.get({})) as StoredCookie[];
  const dupes = duplicateDomainCopies(live, LEMIDA_HOST);
  for (const d of dupes) {
    const twin = live.find(
      (o) =>
        isHostOnly(o) &&
        o.name === d.name &&
        (o.path ?? '/') === (d.path ?? '/') &&
        (o.domain ?? '').replace(/^\./, '') === LEMIDA_HOST,
    );
    try {
      // remove() by url+name clears every copy visible to that URL; repeat to be sure both are gone.
      await ses.cookies.remove(cookieUrl(d as Electron.Cookie), d.name);
      await ses.cookies.remove(cookieUrl(d as Electron.Cookie), d.name);
      if (twin) await ses.cookies.set(toSetDetails(twin) as Electron.CookiesSetDetails);
    } catch {
      // best effort
    }
  }
  if (dupes.length > 0) live = (await ses.cookies.get({})) as StoredCookie[];

  // 3. Restore what is saved and not already live.
  const restored: string[] = [];
  for (const c of cookiesToRestore(await readSavedCookies(), live, LEMIDA_HOST)) {
    try {
      await ses.cookies.set(toSetDetails(c) as Electron.CookiesSetDetails);
      restored.push(c.name);
    } catch {
      // A single malformed cookie shouldn't sink the restore.
    }
  }
  return { restored, deduped: dupes.length, migrated };
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
    // executeJavaScript waits for the main frame to stop loading, so on a page that never finishes loading it
    // never settles (and `catch` can't help): cap it, and treat a timeout as "not logged in".
    const signals = await withTimeout(
      wc.executeJavaScript(
        `(() => ({
        bodyClass: document.body ? document.body.className : '',
        hasLogout: !!document.querySelector('a[href*="/login/logout.php"]'),
        hasLogin: !!document.querySelector('a[href*="/login/index.php"]'),
        hasAvatar: !!document.querySelector('.usermenu .userbutton, .userpicture, img.userpicture, [data-region="user-menu-toggle"]'),
      }))()`,
        true,
      ) as Promise<LoginSignals | null>,
      CHECK_TIMEOUT_MS,
      null,
    );
    if (!signals) return false;
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
export type SignInOutcome = 'signed-in' | 'already-signed-in' | 'timeout' | 'closed' | 'busy';

/**
 * Sign in to Lemida in a visible embedded window on the `persist:lemida` partition. The user completes the
 * Microsoft 365 OAuth by hand; we poll the page until Moodle reports a signed-in session (see
 * `decideLoggedIn`), then persist the cookies for the next launch.
 *
 * Always ends: the poll is raced against the window closing and against `LOGIN_TIMEOUT_MS`, and every check is
 * capped (see `waitForSignIn` / `isLoggedIn`). If the session is already valid nothing is opened or wiped
 * (`already-signed-in`).
 */
// Only one sign-in at a time. A second request while one is in flight (an impatient re-click when the panel
// looked stuck) is a no-op rather than a second window on the same partition. `loginInFlight` is declared up
// top so probe() can see it.
export async function openLogin(
  opts: { onHeartbeat?: () => void } = {},
): Promise<{ status: SessionStatus; outcome: SignInOutcome }> {
  if (loginInFlight) return { status: 'unknown', outcome: 'busy' };
  loginInFlight = true;
  let win: BrowserWindow | undefined;
  try {
    // Probe first: a second sign-in must not wipe a session that is still good.
    if ((await probeSession().catch((): SessionStatus => 'unknown')) === 'valid') {
      return { status: 'valid', outcome: 'already-signed-in' };
    }
    const ses = lemidaSession(); // make sure the plain desktop UA is applied to the partition before loading
    // Start every sign-in from a clean Lemida session, the way the working Playwright/Brave flows get one from
    // a fresh profile. A stale/timed-out MoodleSession (plus PerimeterX block-fcl/__uzm flags) left in the
    // partition makes Moodle treat the OAuth as a session-timeout (errorcode=4) and bounce to the guest front
    // page. clearStorageData's `origin` filter does NOT clear cookies, so remove the BIU cookies explicitly;
    // clear only Lemida's site storage/cache by origin so login.microsoftonline.com (365 SSO) is left intact.
    try {
      const all = await ses.cookies.get({});
      await Promise.all(
        all
          .filter((c) => /biu\.ac\.il/i.test(c.domain ?? ''))
          .map((c) => ses.cookies.remove(cookieUrl(c), c.name).catch(() => {})),
      );
      await ses.clearStorageData({
        origin: 'https://lemida.biu.ac.il',
        storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
      });
      await ses.clearCache();
    } catch {
      // A failed clean shouldn't block the sign-in attempt; worst case it behaves as before.
    }
    const w = new BrowserWindow({
      width: 1100,
      height: 820,
      title: 'Sign in to Lemida',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
    });
    win = w;
    const closedSignal = new AbortController();
    w.on('closed', () => closedSignal.abort());
    // Dock the credential helper to this window so the user can autofill username / password / TOTP. It targets
    // this window's webContents and closes with it; it never touches the main Quire app window.
    openHelper(w, w.webContents);
    // Redirect chains (365 OAuth) can reject loadURL with ERR_ABORTED; ignore and poll the live URL instead.
    w.loadURL(LEMIDA.loginUrl).catch(() => {});
    const outcome = await waitForSignIn({
      check: async () => !w.isDestroyed() && (await isLoggedIn(w.webContents)),
      intervalMs: 1500,
      checkTimeoutMs: CHECK_TIMEOUT_MS,
      deadlineMs: LOGIN_TIMEOUT_MS,
      signal: closedSignal.signal,
      onTick: opts.onHeartbeat,
    });
    if (outcome === 'signed-in') {
      await saveCookies(); // persist the live session for probe/sync and the next launch
      return { status: 'valid', outcome: 'signed-in' };
    }
    return { status: 'unknown', outcome };
  } finally {
    loginInFlight = false;
    if (win) closeHelper();
    // destroy(), not close(): a Moodle page's beforeunload can block close() and leave the window hanging.
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/** The probe body: no in-flight guard (openLogin calls it while it owns `loginInFlight`) and no cookie restore. */
async function probeSession(): Promise<SessionStatus> {
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

/** Load the home page in a hidden window and report whether the reused session is still signed in. */
export async function probe(): Promise<SessionStatus> {
  if (loginInFlight) return 'unknown'; // a sign-in owns the partition right now; don't race it
  return probeSession();
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
  const ses = lemidaSession();
  const win = hiddenWindow();
  try {
    const landed = await navigate(win, course.lemidaUrl);
    if (isAuthWall(landed)) throw new SessionExpired(landed);
    // Not signed in as an enrolled student ⇒ Moodle sends us to the enrolment page, not the course.
    if (/\/enrol\//.test(landed)) {
      throw new SessionExpired(`${landed} (not enrolled, or signed in only as a guest — sign in again)`);
    }
    const resources = await gatherResources(win);
    return await reconcileResources(
      resources,
      { seen, full },
      { collect: (r) => collectDownloads(ses, r), onFile },
    );
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}
