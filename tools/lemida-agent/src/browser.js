// Playwright operations over a persistent Chrome profile on the Mac. The profile holds the session you
// establish by hand; the agent reuses it. Guardrails: it never types credentials and never tries to pass
// a login or bot-check page — if it lands on one, it stops and reports the session as expired.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  filenameFrom,
  isAuthWall,
  parseMoodleCourse,
  parsePluginfileLinks,
  parseResourceWorkaround,
} from './moodle.js';
import { resolveBrowser } from './which-browser.js';

export class SessionExpired extends Error {
  constructor(url) {
    super(`Lemida session expired (hit ${url ?? 'a login/bot page'})`);
    this.name = 'SessionExpired';
  }
}

/** The module types we pull files from; anything else (url, page, quiz, …) is left alone. */
const FILE_MODULES = new Set(['mod_resource', 'mod_folder', 'mod_assign']);

let resolved;
async function launch(config, headless) {
  if (!resolved) {
    resolved = resolveBrowser(config);
    console.log(`browser: ${resolved.name}`);
  }
  return chromium.launchPersistentContext(config.profileDir, {
    headless,
    userAgent: config.userAgent,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
    ...(resolved.channel ? { channel: resolved.channel } : {}),
  });
}

/** Re-inject saved cookies (incl. the Moodle session cookie Chromium drops on close) before navigating. */
async function restoreState(context, config) {
  if (!existsSync(config.stateFile)) return;
  try {
    const state = JSON.parse(await readFile(config.stateFile, 'utf8'));
    if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
  } catch {
    // Corrupt/empty state file — ignore and fall back to the profile's own cookies.
  }
}

/** Persist all cookies (session ones included) after a successful login, for later probe/sync. */
async function saveState(context, config) {
  await context.storageState({ path: config.stateFile });
}

async function isLoggedIn(page) {
  try {
    if (isAuthWall(page.url())) return false;
    // Guests get a .usermenu too (it holds the "Log in" link), so the only reliable marker is a logout
    // link — and a visible login link means we're NOT signed in.
    const logout = await page.$('a[href*="/login/logout.php"]');
    if (!logout) return false;
    const login = await page.$('a[href*="/login/index.php"], a[href*="login/index.php?"]');
    return !login;
  } catch {
    // Page navigated mid-check (e.g. a 365 redirect) — "execution context destroyed"; treat as not-yet.
    return false;
  }
}

/**
 * Open a visible window at the Lemida home so you can sign in by hand (including 365 / any bot check).
 * Returns the session status once you're in, or when the window times out.
 */
export async function openLogin(config) {
  const context = await launch(config, false);
  try {
    await restoreState(context, config); // a still-valid session skips the manual step
    const page = context.pages()[0] ?? (await context.newPage());
    // Straight to the student OAuth sign-in, not /my/ (which bounces guests to a landing page).
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + config.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (await isLoggedIn(page)) {
        await saveState(context, config); // capture the session cookie while it's live
        return 'valid';
      }
      await page.waitForTimeout(2000);
    }
    if (await isLoggedIn(page)) {
      await saveState(context, config);
      return 'valid';
    }
    return 'unknown';
  } finally {
    await context.close();
  }
}

/** Load the home page headlessly and report whether the reused session is still signed in. */
export async function probe(config) {
  const context = await launch(config, true);
  try {
    await restoreState(context, config);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return (await isLoggedIn(page)) ? 'valid' : 'expired';
  } finally {
    await context.close();
  }
}

async function fetchBytes(context, url) {
  const resp = await context.request.get(url, { maxRedirects: 8, timeout: 120_000 });
  const finalUrl = resp.url();
  if (isAuthWall(finalUrl)) throw new SessionExpired(finalUrl);
  if (!resp.ok()) return null;
  return {
    finalUrl,
    contentType: resp.headers()['content-type'] ?? '',
    disposition: resp.headers()['content-disposition'] ?? '',
    resp,
  };
}

/** Download the actual file(s) behind one activity (resource = 1 file; folder/assign = possibly several). */
async function collectDownloads(context, resource) {
  const out = [];
  const head = await fetchBytes(context, resource.href);
  if (!head) return out;
  const isHtml = /text\/html/i.test(head.contentType);

  if (resource.moduleType === 'mod_resource' && !isHtml) {
    out.push({
      name: filenameFrom(head.finalUrl, head.disposition),
      bytes: await head.resp.body(),
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

  for (const url of links) {
    const file = await fetchBytes(context, url);
    if (!file) continue;
    out.push({
      name: filenameFrom(file.finalUrl, file.disposition),
      bytes: await file.resp.body(),
      contentType: file.contentType,
      sourceUrl: file.finalUrl,
    });
  }
  return out;
}

/**
 * Crawl one mapped course and hand each new file to `onFile(download, resource)`. `seen` is a Set of
 * hrefs already imported in earlier runs; those are skipped unless `full` is set.
 */
export async function syncCourse(config, course, onFile, { seen = new Set(), full = false } = {}) {
  const context = await launch(config, true);
  const stats = { resources: 0, downloaded: 0, skipped: 0 };
  try {
    await restoreState(context, config);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(course.lemidaUrl, { waitUntil: 'domcontentloaded' });
    // Course content can hydrate after domcontentloaded; let the network settle before reading the DOM.
    await page.waitForLoadState('networkidle').catch(() => {});
    const landed = page.url();
    if (isAuthWall(landed)) throw new SessionExpired(landed);
    // Not signed in as an enrolled student ⇒ Moodle sends us to the enrolment page, not the course.
    if (/\/enrol\//.test(landed)) {
      throw new SessionExpired(`${landed} (not enrolled, or signed in only as a guest — run \`login\`)`);
    }
    const resources = parseMoodleCourse(await page.content(), page.url()).filter((r) =>
      FILE_MODULES.has(r.moduleType),
    );
    stats.resources = resources.length;
    for (const resource of resources) {
      if (!full && seen.has(resource.href)) {
        stats.skipped++;
        continue;
      }
      const downloads = await collectDownloads(context, resource);
      for (const dl of downloads) {
        await onFile(dl, resource);
        stats.downloaded++;
      }
      seen.add(resource.href);
    }
    return stats;
  } finally {
    await context.close();
  }
}
