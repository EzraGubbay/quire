// Electron-free policy for the Lemida cookie store: which cookies are worth persisting, how to re-inject them
// without turning host-only cookies into domain cookies (bug 8), the on-disk format, and the UA string.
// Pure functions only, so they run under node:test.

/** The subset of Electron.Cookie these helpers read (declared locally so this module never imports electron). */
export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: string;
}

export interface SetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: string;
}

/** Hostname of the Lemida home URL (stand-in servers work too). */
export function lemidaHost(homeUrl: string): string {
  try {
    return new URL(homeUrl).hostname;
  } catch {
    return '';
  }
}

const bareDomain = (c: StoredCookie): string => (c.domain ?? '').replace(/^\./, '');
const pathOf = (c: StoredCookie): string => c.path ?? '/';

/** Host-only: Chromium said so, or (when it didn't say) the domain has no leading dot. */
export function isHostOnly(c: StoredCookie): boolean {
  if (c.hostOnly !== undefined) return c.hostOnly === true;
  return !(c.domain ?? '').startsWith('.');
}

/**
 * Only the Moodle session cookie of the Lemida host is persisted. Chromium already keeps every non-session
 * cookie of the partition on disk; the bot-manager (`__uzm*`) and Microsoft SSO cookies are not needed to reuse
 * the Moodle session and are better left out of a file.
 */
export function isPersistable(c: StoredCookie, host: string): boolean {
  return /^MoodleSession/.test(c.name) && host !== '' && bareDomain(c) === host;
}

/** Details for `ses.cookies.set`. A host-only cookie must be set WITHOUT `domain`, or Chromium makes it a domain cookie. */
export function toSetDetails(c: StoredCookie): SetDetails {
  const host = bareDomain(c);
  const d: SetDetails = {
    url: `${c.secure === false ? 'http' : 'https'}://${host}${pathOf(c)}`,
    name: c.name,
    value: c.value,
  };
  if (!isHostOnly(c) && c.domain) d.domain = c.domain;
  if (c.path !== undefined) d.path = c.path;
  if (c.secure !== undefined) d.secure = c.secure;
  if (c.httpOnly !== undefined) d.httpOnly = c.httpOnly;
  if (c.expirationDate !== undefined) d.expirationDate = c.expirationDate;
  if (c.sameSite !== undefined) d.sameSite = c.sameSite;
  return d;
}

/** Saved cookies worth restoring: persistable ones that the live partition does not already hold (name + path). */
export function cookiesToRestore(saved: StoredCookie[], live: StoredCookie[], host: string): StoredCookie[] {
  return saved.filter(
    (c) => isPersistable(c, host) && !live.some((l) => l.name === c.name && pathOf(l) === pathOf(c)),
  );
}

/**
 * Domain-scoped copies of a Lemida-host cookie that also exists host-only with the same name + path: the twins the
 * old restore created. Domain cookies without a host-only twin, and other hosts, are left alone.
 */
export function duplicateDomainCopies(live: StoredCookie[], host: string): StoredCookie[] {
  if (!host) return [];
  const onHost = live.filter((c) => bareDomain(c) === host);
  return onHost.filter(
    (c) =>
      !isHostOnly(c) && onHost.some((o) => isHostOnly(o) && o.name === c.name && pathOf(o) === pathOf(c)),
  );
}

export function encodeCookieFile(cookies: StoredCookie[], savedAt: Date | string = new Date()): string {
  return JSON.stringify({
    v: 1,
    savedAt: typeof savedAt === 'string' ? savedAt : savedAt.toISOString(),
    cookies,
  });
}

/** Tolerates the legacy `{ cookies: [...] }` file; anything unparseable yields `[]`. */
export function decodeCookieFile(text: string): StoredCookie[] {
  try {
    const parsed = JSON.parse(text) as { cookies?: unknown };
    if (!parsed || !Array.isArray(parsed.cookies)) return [];
    return parsed.cookies.filter(
      (c): c is StoredCookie =>
        !!c && typeof c === 'object' && typeof c.name === 'string' && typeof c.value === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Chrome's reduced UA: `major.0.0.0` with the macOS token frozen at 10_15_7. Built from the bundled Chromium
 * version so it agrees with the real `Sec-CH-UA` client hints; falls back to 131 if the version is missing.
 */
export function desktopUserAgent(chromeVersion?: string): string {
  const major = /^(\d+)/.exec(chromeVersion ?? '')?.[1] ?? '131';
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
