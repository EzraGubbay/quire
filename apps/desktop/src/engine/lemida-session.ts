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
import { app, BrowserWindow, net, type Session, safeStorage, session, type WebContents } from 'electron';
import { closeHelper, openHelper } from './credential-bar';
import { collectActivity, type Download } from './downloads';
import { NotEnrolled, SessionExpired } from './errors';
import { type RawResponse, redactUrl } from './fetch-outcome';
import { waitForSignIn, withTimeout } from './lifecycle';
import { decideLoggedIn, isAuthWall, type LoginSignals, parseMoodleCourse, type Resource } from './moodle';
import { type CourseStats, reconcileResources, type UploadOutcome } from './reconcile';
import type { CourseRecords, FileRecord } from './seen';
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
  sessionFromCheck,
  shouldWipeBeforeSignIn,
  toSetDetails,
} from './session-policy';

export type SessionStatus = 'valid' | 'expired' | 'unknown';

export { NotEnrolled, SessionExpired };

export interface SyncCourse {
  slug: string;
  lemidaUrl: string;
  mappingId?: string;
  label?: string;
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
    if (!hasEnc && keep.length > 0) {
      const wrote = await writeEncrypted(encodeCookieFile(keep));
      if (!wrote) {
        console.warn(
          '[lemida] cookies: plaintext cookie file deleted and the saved session dropped, because Keychain encryption is unavailable (sign in again)',
        );
      }
    }
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
      // remove() by url+name clears every copy visible to that URL (both twins); the host-only one is re-set below.
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

/** true/false = a verdict; null = could not tell (the check timed out), which callers must not read as "signed out". */
async function isLoggedIn(wc: WebContents): Promise<boolean | null> {
  try {
    const url = wc.getURL();
    if (isAuthWall(url)) return false;
    // Gather the signals Moodle exposes and let the pure `decideLoggedIn` judge them. The authoritative one
    // is the `userloggedin` / `notloggedin` class Moodle puts on <body>; the logout-link / avatar checks are
    // fallbacks for a theme that omits it. (Keying on the logout link alone used to miss real sign-ins.)
    // executeJavaScript waits for the main frame to stop loading, so on a page that never finishes loading it
    // never settles (and `catch` can't help): cap it, and report a timeout as "could not tell" (null).
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
    if (!signals) return null;
    return decideLoggedIn(url, signals);
  } catch {
    // Page navigated mid-check (e.g. a 365 redirect) — treat as not-yet.
    return false;
  }
}

function hiddenWindow(): BrowserWindow {
  lemidaSession(); // make sure the plain desktop UA is applied to the partition before anything loads
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
    const pre = await probeSession().catch((): SessionStatus => 'unknown');
    if (pre === 'valid') return { status: 'valid', outcome: 'already-signed-in' };
    const ses = lemidaSession(); // make sure the plain desktop UA is applied to the partition before loading
    // Start every sign-in from a clean Lemida session, the way the working Playwright/Brave flows get one from
    // a fresh profile. A stale/timed-out MoodleSession (plus PerimeterX block-fcl/__uzm flags) left in the
    // partition makes Moodle treat the OAuth as a session-timeout (errorcode=4) and bounce to the guest front
    // page. clearStorageData's `origin` filter does NOT clear cookies, so remove the BIU cookies explicitly;
    // clear only Lemida's site storage/cache by origin so login.microsoftonline.com (365 SSO) is left intact.
    // Only when the probe positively said "signed out": if it merely could not tell (timeout), leave the session
    // alone and just open the window. Bounded so a hung clear can't leave `loginInFlight` stuck.
    if (shouldWipeBeforeSignIn(pre)) {
      await withTimeout(
        (async () => {
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
        })(),
        15_000,
        undefined, // a failed or slow clean shouldn't block the sign-in attempt
      );
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
      check: async () => !w.isDestroyed() && (await isLoggedIn(w.webContents)) === true,
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
    return sessionFromCheck(ok);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Load the home page in a hidden window and report whether the reused session is still signed in. */
export async function probe(): Promise<SessionStatus> {
  if (loginInFlight) return 'unknown'; // a sign-in owns the partition right now; don't race it
  return probeSession();
}

const MAX_BYTES = 200 * 1024 * 1024; // matches the server's limit in apps/web import/route.ts
const MAX_HOPS = 10;
/** Inactivity timeout: fires when no response/data arrives for this long (not a whole-body deadline). */
const FETCH_TIMEOUT_MS = Number(process.env.LEMIDA_FETCH_TIMEOUT_MS ?? 120_000);
/** Minimum gap between Lemida requests, to stay polite to the bot manager. One place to tune. */
const REQUEST_PACE_MS = 300;

let lastRequestAt = 0;
async function pace(): Promise<void> {
  const wait = lastRequestAt + REQUEST_PACE_MS - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + REQUEST_PACE_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Paced GET through the Lemida session; see httpGetOnce. */
export async function httpGet(
  ses: Session,
  url: string,
  opts: { ifNoneMatch?: string } = {},
): Promise<RawResponse> {
  await pace();
  return httpGetOnce(ses, url, opts);
}

/**
 * One GET through the Lemida session via net.request, recording every redirect hop. Session.fetch cannot be
 * used here: Electron documents its Response.url/type as incorrect, so a bounce to the login page was
 * invisible. Always resolves (never throws, never hangs); transport problems come back in `error`.
 */
function httpGetOnce(ses: Session, url: string, opts: { ifNoneMatch?: string }): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve) => {
    const hops: string[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: Partial<RawResponse>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        requestedUrl: url,
        hops,
        finalUrl: hops.length ? (hops[hops.length - 1] as string) : url,
        status: 0,
        headers: {},
        body: null,
        ...r,
      });
    };
    let request: ReturnType<typeof net.request>;
    try {
      request = net.request({
        url,
        session: ses,
        useSessionCookies: true,
        redirect: 'manual',
        // no-store keeps Chromium's HTTP cache from answering instead of Lemida (the log then shows the live
        // answer) without adding Cache-Control/Pragma headers a normal navigation would not send. A manual
        // If-None-Match still reaches Moodle, so a 304 comes back to us.
        cache: 'no-store',
        headers: {
          'user-agent': LEMIDA.userAgent,
          // Cheap hypothesis: the previous download request sent no Accept header at all.
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}),
        },
      });
    } catch (err) {
      done({ error: 'network_error', errorMessage: (err as Error).message });
      return;
    }
    // If a 304 never shows up, the sha256 fallback in downloads.ts keeps the result correct (only bandwidth
    // is wasted). The timer is re-armed on every response/data event, so slow large downloads can finish.
    const arm = (): void => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        done({ error: 'timeout', errorMessage: `no data for ${FETCH_TIMEOUT_MS}ms` });
        request.abort();
      }, FETCH_TIMEOUT_MS);
    };
    arm();
    request.on('redirect', (_status, _method, redirectUrl) => {
      hops.push(redirectUrl);
      if (isAuthWall(redirectUrl)) {
        done({ error: 'aborted_auth_wall' });
        request.abort();
        return;
      }
      if (hops.length > MAX_HOPS) {
        done({ error: 'network_error', errorMessage: 'too many redirects' });
        request.abort();
        return;
      }
      request.followRedirect();
    });
    request.on('response', (response) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      arm();
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        done({ status: response.statusCode, headers, error: 'too_large' });
        request.abort();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk) => {
        arm();
        total += chunk.length;
        if (total > MAX_BYTES) {
          done({ status: response.statusCode, headers, error: 'too_large' });
          request.abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => done({ status: response.statusCode, headers, body: Buffer.concat(chunks) }));
      response.on('error', (err: Error) => done({ error: 'network_error', errorMessage: err.message }));
    });
    request.on('error', (err) => done({ error: 'network_error', errorMessage: err.message }));
    request.on('abort', () => done({ error: 'network_error', errorMessage: 'aborted' }));
    request.end();
  });
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

export interface SyncCourseDeps {
  /** This course's records (live object owned by the SeenStore). */
  records: CourseRecords;
  full: boolean;
  upload: (download: Download, resource: Resource) => Promise<UploadOutcome>;
  recordFile: (activityHref: string, fileUrl: string, rec: FileRecord) => void;
  persist: () => Promise<void>;
  log: (msg: string) => void;
  /** Called once the course page loaded signed in and enrolled. */
  onLoaded?: () => void;
  /** True once the engine watchdog has abandoned this sync: stop between activities. */
  shouldStop?: () => boolean;
  /** Called after each activity (restarts the watchdog's idle deadline). */
  onProgress?: () => void;
}

/** Crawl one mapped course and upload each new or changed file; records only what the server accepted. */
export async function syncCourse(
  course: SyncCourse,
  { records, full, upload, recordFile, persist, log, onLoaded, shouldStop, onProgress }: SyncCourseDeps,
): Promise<CourseStats> {
  const ses = lemidaSession();
  const win = hiddenWindow();
  const name = course.label ?? course.slug;
  try {
    const landed = await navigate(win, course.lemidaUrl);
    log(`course ${name} page=${redactUrl(landed)}`);
    if (isAuthWall(landed)) throw new SessionExpired(landed);
    // Signed in but sent to the enrolment page: not enrolled in this course (other courses are unaffected).
    if (/\/enrol\//.test(landed)) throw new NotEnrolled(landed);
    onLoaded?.();
    const resources = await gatherResources(win);
    log(`course ${name} activities=${resources.length}`);
    return await reconcileResources(
      resources,
      { records, full },
      {
        collect: (r) =>
          collectActivity(r, { get: (u, o) => httpGet(ses, u, o), records: records[r.href], full, log }),
        upload,
        recordFile,
        persist,
        log,
        shouldStop,
        onProgress,
      },
    );
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}
