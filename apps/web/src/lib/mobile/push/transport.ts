// Push transports (ADR 0003 §3.3–§3.4). `fcmTransport` talks FCM HTTP v1 with an OAuth2 access token minted from a
// self-signed RS256 JWT (node:crypto, no dependency) and classifies failures by the FCM error detail, never by HTTP
// status alone. Nothing here logs: not the JWT, the access token, OAuth/FCM response bodies, FCM tokens or
// err.message. `errorCode` is an FCM/google.rpc code (sanitised to [A-Z0-9_]) or a fixed local code.
import { sign } from 'node:crypto';
import type { FcmConfig } from './config';
import type { PushPriority } from './events';

export interface PushMessage {
  /** The FCM registration token. Secret: never logged. */
  token: string;
  data: Record<string, string>;
  priority: PushPriority;
  ttlSeconds: number;
  collapseKey?: string;
  /** For logs only (never sent): the registration row id. */
  registrationId?: string;
}

export type FailureKind = 'unregistered' | 'retryable' | 'config' | 'fatal';
export type SendResult =
  | { ok: true }
  | { ok: false; kind: FailureKind; errorCode: string; retryAfterMs?: number };

export interface PushTransport {
  send(m: PushMessage): Promise<SendResult>;
}

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const fcmSendUrl = (projectId: string) =>
  `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

const FCM_ERROR_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';
/** The credential or project does not match the app; the device is fine, so the registration is kept. */
const CONFIG_CODES = new Set(['SENDER_ID_MISMATCH', 'PERMISSION_DENIED', 'UNAUTHENTICATED']);
const RETRYABLE_CODES = new Set([
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'ABORTED',
]);
const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh the cached access token this long before it expires. */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/** Only enum-shaped codes from a response may reach logs or `last_error`; anything else becomes UNKNOWN. */
const safeCode = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : undefined;

/** `Retry-After` as delta-seconds or an HTTP date → ms from now; undefined when absent or unparseable. */
export function parseRetryAfter(h: string | null, nowMs: number): number | undefined {
  if (!h) return undefined;
  const t = h.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * Classify a non-2xx FCM response. The code is the FcmError `errorCode` from `error.details[]`, else the
 * google.rpc `error.status`. Prune only on UNREGISTERED, or INVALID_ARGUMENT with a `message.token` field
 * violation. A body without either (an HTML proxy page, say) falls back to `HTTP_<status>`: retryable for
 * 429/5xx, fatal otherwise, and never a prune.
 */
export function classifyFcmError(
  status: number,
  body: unknown,
  retryAfter: string | null,
  nowMs: number,
): Extract<SendResult, { ok: false }> {
  const err = (body as { error?: { status?: unknown; details?: unknown } } | null)?.error;
  const details = Array.isArray(err?.details) ? (err.details as Array<Record<string, unknown>>) : [];
  const fcmCode = safeCode(details.find((d) => d?.['@type'] === FCM_ERROR_TYPE)?.errorCode);
  const rpcStatus = safeCode(err?.status);
  const tokenViolation = details.some(
    (d) =>
      d?.['@type'] === BAD_REQUEST_TYPE &&
      Array.isArray(d.fieldViolations) &&
      (d.fieldViolations as Array<{ field?: unknown }>).some((v) => v?.field === 'message.token'),
  );
  const code = fcmCode ?? rpcStatus;
  const retryAfterMs = parseRetryAfter(retryAfter, nowMs);
  const withRetry = retryAfterMs === undefined ? {} : { retryAfterMs };

  if (code === 'UNREGISTERED') return { ok: false, kind: 'unregistered', errorCode: code };
  if (code === 'INVALID_ARGUMENT' && tokenViolation)
    return { ok: false, kind: 'unregistered', errorCode: code };
  if (code && CONFIG_CODES.has(code)) return { ok: false, kind: 'config', errorCode: code };
  if (code && RETRYABLE_CODES.has(code))
    return { ok: false, kind: 'retryable', errorCode: code, ...withRetry };
  if (code) return { ok: false, kind: 'fatal', errorCode: code };
  if (status === 401) return { ok: false, kind: 'config', errorCode: 'UNAUTHENTICATED' };
  const fallback = `HTTP_${status}`;
  if (status === 429 || status >= 500)
    return { ok: false, kind: 'retryable', errorCode: fallback, ...withRetry };
  return { ok: false, kind: 'fatal', errorCode: fallback };
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** The self-signed RS256 assertion exchanged for an access token (Google service-account OAuth). */
export function buildJwt(c: Pick<FcmConfig, 'clientEmail' | 'privateKey'>, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: c.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const input = `${header}.${claims}`;
  const sig = sign('RSA-SHA256', Buffer.from(input, 'utf8'), c.privateKey).toString('base64url');
  return `${input}.${sig}`;
}

/** The FCM HTTP v1 request body for one message. */
export function fcmRequestBody(m: PushMessage) {
  return {
    message: {
      token: m.token,
      data: m.data,
      android: {
        priority: m.priority,
        ttl: `${Math.max(0, Math.floor(m.ttlSeconds))}s`,
        ...(m.collapseKey ? { collapse_key: m.collapseKey } : {}),
      },
    },
  };
}

type Fetch = typeof globalThis.fetch;
type TokenResult = { ok: true; token: string } | Extract<SendResult, { ok: false }>;

/** Network failures carry no detail worth keeping; the name is a fixed class, never the message. */
const networkFailure = (e: unknown): Extract<SendResult, { ok: false }> => ({
  ok: false,
  kind: 'retryable',
  errorCode: (e as { name?: string })?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
});

export function fcmTransport(
  config: FcmConfig,
  opts: { fetch?: Fetch; now?: () => number } = {},
): PushTransport & { clearToken(): void } {
  const doFetch: Fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | null = null;

  async function accessToken(): Promise<TokenResult> {
    if (cached && now() < cached.expiresAtMs - TOKEN_SKEW_MS) return { ok: true, token: cached.token };
    let assertion: string;
    try {
      assertion = buildJwt(config, Math.floor(now() / 1000));
    } catch {
      return { ok: false, kind: 'config', errorCode: 'BAD_PRIVATE_KEY' };
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
      return networkFailure(e);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return res.status === 429 || res.status >= 500
        ? { ok: false, kind: 'retryable', errorCode: 'OAUTH_UNAVAILABLE' }
        : { ok: false, kind: 'config', errorCode: 'OAUTH_REJECTED' };
    }
    const body = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (typeof body?.access_token !== 'string' || !body.access_token)
      return { ok: false, kind: 'retryable', errorCode: 'OAUTH_UNAVAILABLE' };
    const ttlS = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    cached = { token: body.access_token, expiresAtMs: now() + ttlS * 1000 };
    return { ok: true, token: cached.token };
  }

  async function attempt(m: PushMessage): Promise<{ result: SendResult; status: number }> {
    const t = await accessToken();
    if (!t.ok) return { result: t, status: 0 };
    let res: Response;
    try {
      res = await doFetch(fcmSendUrl(config.projectId), {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmRequestBody(m)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { result: networkFailure(e), status: 0 };
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { result: { ok: true }, status: res.status };
    }
    const body = await res.json().catch(() => null);
    return {
      result: classifyFcmError(res.status, body, res.headers.get('retry-after'), now()),
      status: res.status,
    };
  }

  return {
    clearToken() {
      cached = null;
    },
    async send(m) {
      const first = await attempt(m);
      const rejected =
        !first.result.ok && (first.status === 401 || first.result.errorCode === 'UNAUTHENTICATED');
      if (!rejected) return first.result;
      // The access token was rejected: drop it and try once more with a fresh one.
      cached = null;
      return (await attempt(m)).result;
    },
  };
}

export interface FakeTransport extends PushTransport {
  readonly sent: PushMessage[];
  /** Queue results for a token; each send to it takes the next one, then `{ ok: true }`. */
  script(token: string, ...results: SendResult[]): void;
}

/** Records messages; scriptable per token. With `log`, prints type and registration id only (never the token). */
export function fakeTransport(opts: { log?: boolean } = {}): FakeTransport {
  const sent: PushMessage[] = [];
  const scripts = new Map<string, SendResult[]>();
  return {
    sent,
    script(token, ...results) {
      scripts.set(token, [...(scripts.get(token) ?? []), ...results]);
    },
    async send(m) {
      sent.push(m);
      if (opts.log)
        console.log(
          `[push:fake] sent type=${m.data.type ?? 'unknown'} registration=${m.registrationId ?? '-'}`,
        );
      return scripts.get(m.token)?.shift() ?? { ok: true };
    },
  };
}
