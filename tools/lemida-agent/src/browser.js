// Playwright operations over a persistent Chrome profile on the Mac. The profile holds the session you
// establish by hand; the agent reuses it. Guardrails: it never types credentials and never tries to pass
// a login or bot-check page — if it lands on one, it stops and reports the session as expired.
import { chromium } from 'playwright';
import {
  filenameFrom,
  isAuthWall,
  parseMoodleCourse,
  parsePluginfileLinks,
  parseResourceWorkaround,
} from './moodle.js';

export class SessionExpired extends Error {
  constructor(url) {
    super(`Lemida session expired (hit ${url ?? 'a login/bot page'})`);
    this.name = 'SessionExpired';
  }
}

/** The module types we pull files from; anything else (url, page, quiz, …) is left alone. */
const FILE_MODULES = new Set(['mod_resource', 'mod_folder', 'mod_assign']);

async function launch(config, headless) {
  return chromium.launchPersistentContext(config.profileDir, {
    headless,
    userAgent: config.userAgent,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
}

async function isLoggedIn(page) {
  if (isAuthWall(page.url())) return false;
  const marker = await page.$(
    'a[href*="logout.php"], .usermenu, #user-menu-toggle, [data-region="user-menu"]',
  );
  return Boolean(marker);
}

/**
 * Open a visible window at the Lemida home so you can sign in by hand (including 365 / any bot check).
 * Returns the session status once you're in, or when the window times out.
 */
export async function openLogin(config) {
  const context = await launch(config, false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + config.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (await isLoggedIn(page)) return 'valid';
      await page.waitForTimeout(2000);
    }
    return (await isLoggedIn(page)) ? 'valid' : 'unknown';
  } finally {
    await context.close();
  }
}

/** Load the home page headlessly and report whether the reused session is still signed in. */
export async function probe(config) {
  const context = await launch(config, true);
  try {
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
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(course.lemidaUrl, { waitUntil: 'domcontentloaded' });
    if (isAuthWall(page.url())) throw new SessionExpired(page.url());
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
