// Pure classification of a raw Lemida HTTP answer, plus the sanitised one-line diagnostic for the sync log.
// No Electron imports. Final URLs come from the redirect hops recorded by net.request, never Response.url
// (which Electron's Session.fetch reports incorrectly).
import { isAuthWall } from './moodle';

export interface RawResponse {
  requestedUrl: string;
  hops: string[];
  finalUrl: string;
  status: number;
  /** Lower-cased header names; array values joined with ", ". */
  headers: Record<string, string>;
  body: Buffer | null;
  error?: 'timeout' | 'too_large' | 'network_error' | 'aborted_auth_wall';
  errorMessage?: string;
}

export type OutcomeKind =
  | 'file'
  | 'not_modified'
  | 'page'
  | 'resource_page'
  | 'html_no_link'
  | 'login_page'
  | 'bot_page'
  | 'non_2xx'
  | 'too_large'
  | 'timeout'
  | 'network_error';

export interface Outcome {
  kind: OutcomeKind;
  status: number;
  detail: string;
  /** Decoded body for HTML outcomes (page / html_no_link), else undefined. */
  html?: string;
}

const BOT_HOSTS = /perfdrive/i;
const BOT_MARKERS = /perfdrive|shieldsquare|captcha|radware|bot manager|access denied/i;

export function looksLikeBotPage(html: string): boolean {
  return BOT_MARKERS.test(html);
}

/**
 * A genuine Moodle page (signed-in chrome or an activity page). Lemida's bot manager may inject a perfdrive
 * script into every page, and a folder may list "CAPTCHA.pdf", so bot markers only count on pages that do NOT
 * have Moodle chrome.
 */
export function looksLikeMoodlePage(html: string): boolean {
  return (
    /<body[^>]*\bclass=["'][^"']*\b(userloggedin|path-mod[-\w]*|path-course[-\w]*|path-my)\b/i.test(html) ||
    /\bid=["']page-mod-/i.test(html)
  );
}

export function looksLikeLoginPage(html: string): boolean {
  return (
    /<form[^>]*action=["'][^"']*\/login\/index\.php/i.test(html) ||
    /<form[^>]*id=["']login["']/i.test(html) ||
    /<body[^>]*class=["'][^"']*\bnotloggedin\b/i.test(html) ||
    /<form[^>]*action=["'][^"']*login\.microsoftonline\.com/i.test(html)
  );
}

export function looksLikeModPage(html: string, moduleType?: string): boolean {
  if (!moduleType) return false;
  const t = moduleType.replace(/^mod_/, '');
  return (
    new RegExp(`id=["']page-mod-${t}-`, 'i').test(html) ||
    new RegExp(`class=["'][^"']*\\bpath-mod-${t}\\b`, 'i').test(html)
  );
}

function isHtml(raw: RawResponse): boolean {
  const ct = raw.headers['content-type'] ?? '';
  if (/text\/html|application\/xhtml/i.test(ct)) return true;
  const head = raw.body?.subarray(0, 64).toString('latin1').trimStart().toLowerCase() ?? '';
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

export function classifyResponse(raw: RawResponse, expect: 'file' | 'page', moduleType?: string): Outcome {
  const urls = [...raw.hops, raw.finalUrl].filter(Boolean);
  const mk = (kind: OutcomeKind, detail: string, html?: string): Outcome => ({
    kind,
    status: raw.status,
    detail,
    html,
  });
  const bot = urls.find((u) => BOT_HOSTS.test(u));
  if (bot) return mk('bot_page', `redirected to ${redactUrl(bot)}`);
  const wall = urls.find((u) => isAuthWall(u));
  if (wall) return mk('login_page', `redirected to ${redactUrl(wall)}`);

  if (raw.error === 'aborted_auth_wall') return mk('login_page', 'redirect to an auth wall');
  if (raw.error) return mk(raw.error, raw.errorMessage ?? raw.error);

  if (raw.status === 304) return mk('not_modified', 'not modified');
  if (raw.status < 200 || raw.status >= 300) return mk('non_2xx', `HTTP ${raw.status}`);

  if (isHtml(raw)) {
    const html = raw.body?.toString('utf8') ?? '';
    if (looksLikeLoginPage(html)) return mk('login_page', 'login page');
    if (!looksLikeMoodlePage(html) && looksLikeBotPage(html)) return mk('bot_page', 'bot-manager page');
    if (expect === 'file') return mk('html_no_link', 'HTML page where a file was expected', html);
    if (looksLikeModPage(html, moduleType) || /\/pluginfile\.php\//i.test(html)) {
      return mk('page', 'activity page', html);
    }
    return mk('html_no_link', 'HTML page is not an activity page', html);
  }
  return mk('file', 'file');
}

// --- sanitising ---------------------------------------------------------------------------------------

const KV_SECRET =
  /\b(sesskey|logintoken|token|key|sig|signature|auth|code|state|nonce|session\w*)=[^&"'\s]+/gi;
const JSON_SECRET =
  /"(\w*(?:sesskey|logintoken|token|key|sig|signature|auth|code|state|nonce|session)\w*)"\s*:\s*"[^"]*("|$)/gi;
const SNIPPET_WINDOW = 1024; // redact over a wider window, then truncate, so a secret cut at the edge cannot leak

/** Redact secret-looking query values in a URL. */
export function redactUrl(url: string): string {
  return url.replace(KV_SECRET, '$1=[redacted]');
}

/**
 * First `max` characters of a body as printable, redacted text. HTML/text keeps unicode letters (Hebrew);
 * binary is ASCII-only so a PDF still reads `%PDF-1.7 ...`.
 */
export function sanitizeSnippet(buf: Buffer | null, max = 200, opts: { text?: boolean } = {}): string {
  if (!buf || buf.length === 0) return '';
  const slice = buf.subarray(0, SNIPPET_WINDOW);
  const text = opts.text || /^\s*</.test(slice.toString('latin1', 0, 16));
  let s = slice.toString(text ? 'utf8' : 'latin1');
  s = text ? s.replace(/[^\p{L}\p{N}\p{P}\p{S}\s]|�/gu, '.') : s.replace(/[^\x20-\x7e\s]/g, '.');
  s = s.replace(/\s+/g, ' ');
  s = s
    .replace(/value\s*=\s*"[^"]*("|$)/gi, 'value="[redacted]"')
    .replace(/value\s*=\s*'[^']*('|$)/gi, "value='[redacted]'");
  s = s.replace(JSON_SECRET, '"$1":"[redacted]"');
  s = s.replace(KV_SECRET, '$1=[redacted]');
  s = s.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '[redacted]');
  return s.slice(0, max);
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return '';
  return sanitizeSnippet(Buffer.from(m[1].trim(), 'utf8'), 80, { text: true });
}

export function formatRequestLog(activityHref: string, raw: RawResponse, outcome: Outcome): string {
  const h = raw.headers;
  const final = raw.hops.length ? raw.hops[raw.hops.length - 1] : raw.requestedUrl;
  const len = h['content-length'] ?? String(raw.body?.length ?? 0);
  const html = isHtml(raw) ? (outcome.html ?? raw.body?.toString('utf8') ?? '') : '';
  const title = html ? pageTitle(html) : '';
  return [
    `req activity=${redactUrl(activityHref)}`,
    `url=${redactUrl(raw.requestedUrl)}`,
    `final=${redactUrl(final ?? '')}`,
    `hops=${raw.hops.length}`,
    `status=${raw.status}`,
    `type=${(h['content-type'] ?? '').split(';')[0]?.trim() ?? ''}`,
    `len=${len}`,
    `disp=${h['content-disposition'] ? 'yes' : 'no'}`,
    `etag=${h.etag ? 'yes' : 'no'}`,
    `outcome=${outcome.kind}`,
    `title="${title}"`,
    `head="${sanitizeSnippet(raw.body)}"`,
  ].join(' ');
}
