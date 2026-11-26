// Service-account JWT signing and token exchange for the Drive inbox. Mirrors lib/mobile/push/transport.ts
// (node:crypto only, no googleapis dependency) with the scope as a parameter. Errors are fixed-text
// DriveErrors: nothing derived from the key, the assertion, the token or a response body is ever kept.
import { sign } from 'node:crypto';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type DriveErrorCode =
  | 'AUTH_REJECTED'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'NOT_VISIBLE'
  | 'TOO_LARGE'
  | 'EXPORT_TOO_LARGE'
  | 'BAD_RESPONSE';

const MESSAGES: Record<DriveErrorCode, string> = {
  AUTH_REJECTED:
    "Quire's Google Drive access is misconfigured (the service account was rejected). Tell the user to check the Drive inbox setup.",
  UNAVAILABLE: 'Google Drive is temporarily unavailable; retry in a minute.',
  NETWORK: 'Could not reach Google Drive; retry in a minute.',
  TIMEOUT: 'Google Drive took too long to answer; retry in a minute.',
  NOT_VISIBLE: 'Quire cannot see that Drive file.',
  TOO_LARGE: 'The Drive file is larger than Quire accepts.',
  EXPORT_TOO_LARGE:
    "Google could not export that document as Markdown because it is over Google's 10 MB export limit.",
  BAD_RESPONSE: 'Google Drive returned an unexpected answer; retry in a minute.',
};

export class DriveError extends Error {
  constructor(readonly code: DriveErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DriveError';
  }
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** The self-signed RS256 assertion exchanged for an access token. */
export function buildServiceJwt(
  c: { clientEmail: string; privateKey: string },
  scope: string,
  nowSec: number,
): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: c.clientEmail, scope, aud: OAUTH_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const input = `${header}.${claims}`;
  const sig = sign('RSA-SHA256', Buffer.from(input, 'utf8'), c.privateKey).toString('base64url');
  return `${input}.${sig}`;
}

type Fetch = typeof globalThis.fetch;

/** Network failures carry no detail worth keeping; the class is fixed, never the message. */
export const networkError = (e: unknown): DriveError =>
  new DriveError((e as { name?: string })?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');

export interface TokenSource {
  getToken(): Promise<string>;
  clear(): void;
}

export function serviceTokenSource(
  config: { clientEmail: string; privateKey: string },
  opts: { fetch?: Fetch; now?: () => number; scope?: string } = {},
): TokenSource {
  const doFetch: Fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = opts.now ?? Date.now;
  const scope = opts.scope ?? DRIVE_READONLY_SCOPE;
  let cached: { token: string; expiresAtMs: number } | null = null;
  return {
    clear() {
      cached = null;
    },
    async getToken() {
      if (cached && now() < cached.expiresAtMs - TOKEN_SKEW_MS) return cached.token;
      let assertion: string;
      try {
        assertion = buildServiceJwt(config, scope, Math.floor(now() / 1000));
      } catch {
        throw new DriveError('AUTH_REJECTED');
      }
      let res: Response;
      try {
        res = await doFetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new DriveError(res.status === 429 || res.status >= 500 ? 'UNAVAILABLE' : 'AUTH_REJECTED');
      }
      const body = (await res.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;
      if (typeof body?.access_token !== 'string' || !body.access_token) throw new DriveError('BAD_RESPONSE');
      const ttlS = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
      cached = { token: body.access_token, expiresAtMs: now() + ttlS * 1000 };
      return cached.token;
    },
  };
}
