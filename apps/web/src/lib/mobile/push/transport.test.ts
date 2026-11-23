// @vitest-environment node
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FcmConfig } from './config';
import {
  buildJwt,
  classifyFcmError,
  FCM_SCOPE,
  fakeTransport,
  fcmTransport,
  OAUTH_TOKEN_URL,
  type PushMessage,
  parseRetryAfter,
} from './transport';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config: FcmConfig = {
  enabled: true,
  transport: 'fcm',
  projectId: 'quire-push-test',
  clientEmail: 'fcm@quire-push-test.iam.gserviceaccount.com',
  privateKey: PEM,
};
const FCM_URL = 'https://fcm.googleapis.com/v1/projects/quire-push-test/messages:send';
const FCM_TOKEN = 'fcm-registration-token-SECRET';
const ACCESS_TOKEN = 'ya29.access-token-SECRET';

const msg: PushMessage = {
  token: FCM_TOKEN,
  data: { v: '1', type: 'push.test', eventId: 'e1' },
  priority: 'HIGH',
  ttlSeconds: 300,
  collapseKey: 'push.test',
  registrationId: 'reg-1',
};

const fcmErr = (status: string, errorCode?: string, extra: object[] = []) => ({
  error: {
    code: 400,
    message: `Requested entity ${FCM_TOKEN} not found`,
    status,
    details: [
      ...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []),
      ...extra,
    ],
  },
});
const tokenViolation = {
  '@type': 'type.googleapis.com/google.rpc.BadRequest',
  fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }],
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A scripted fetch: OAuth always succeeds unless overridden; FCM answers from `fcm` in order. */
function fakeFetch(fcm: Array<Response | Error>, oauth: Array<Response | Error> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const queue = String(url) === OAUTH_TOKEN_URL ? oauth : fcm;
    const next =
      queue.shift() ??
      (String(url) === OAUTH_TOKEN_URL
        ? json(200, { access_token: ACCESS_TOKEN, expires_in: 3600 })
        : json(200, {}));
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => {
  // The transport never logs anything: no JWT, access token, bodies, FCM tokens or err.message.
  expect(logs).toEqual([]);
  vi.restoreAllMocks();
});

describe('buildJwt', () => {
  it('is an RS256 JWT for the FCM scope, signed by the service-account key', () => {
    const jwt = buildJwt(config, 1_800_000_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: config.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('fcmTransport request shape', () => {
  it('exchanges the JWT for an access token, then posts a data-only HTTP v1 message', async () => {
    const f = fakeFetch([]);
    const t = fcmTransport(config, { fetch: f.fetch, now: () => 1_800_000_000_000 });
    expect(await t.send(msg)).toEqual({ ok: true });

    const [oauth, send] = f.calls;
    expect(oauth?.url).toBe(OAUTH_TOKEN_URL);
    const form = new URLSearchParams(String(oauth?.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);

    expect(send?.url).toBe(FCM_URL);
    expect(send?.init.method).toBe('POST');
    expect((send?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
    expect(JSON.parse(String(send?.init.body))).toEqual({
      message: {
        token: FCM_TOKEN,
        data: { v: '1', type: 'push.test', eventId: 'e1' },
        android: { priority: 'HIGH', ttl: '300s', collapse_key: 'push.test' },
      },
    });
  });

  it('omits collapse_key when there is none, and never sends a notification block', async () => {
    const f = fakeFetch([]);
    await fcmTransport(config, { fetch: f.fetch }).send({
      ...msg,
      collapseKey: undefined,
      priority: 'NORMAL',
    });
    const body = JSON.parse(String(f.calls[1]?.init.body));
    expect(body.message.android).toEqual({ priority: 'NORMAL', ttl: '300s' });
    expect(body.message.notification).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('reg-1');
  });

  it('caches the access token until 5 minutes before expiry', async () => {
    let now = 1_800_000_000_000;
    const f = fakeFetch([]);
    const t = fcmTransport(config, { fetch: f.fetch, now: () => now });
    await t.send(msg);
    now += 54 * 60 * 1000;
    await t.send(msg);
    expect(f.calls.filter((c) => c.url === OAUTH_TOKEN_URL)).toHaveLength(1);
    now += 2 * 60 * 1000; // 56 min: inside the 5-minute skew
    await t.send(msg);
    expect(f.calls.filter((c) => c.url === OAUTH_TOKEN_URL)).toHaveLength(2);
  });

  it('a 401 drops the cached token and retries once with a fresh one', async () => {
    const f = fakeFetch([json(401, fcmErr('UNAUTHENTICATED')), json(200, {})]);
    expect(await fcmTransport(config, { fetch: f.fetch }).send(msg)).toEqual({ ok: true });
    expect(f.calls.map((c) => c.url)).toEqual([OAUTH_TOKEN_URL, FCM_URL, OAUTH_TOKEN_URL, FCM_URL]);
  });

  it('a 401 that persists after the refresh is config-fatal', async () => {
    const f = fakeFetch([json(401, fcmErr('UNAUTHENTICATED')), json(401, fcmErr('UNAUTHENTICATED'))]);
    expect(await fcmTransport(config, { fetch: f.fetch }).send(msg)).toEqual({
      ok: false,
      kind: 'config',
      errorCode: 'UNAUTHENTICATED',
    });
    expect(f.calls.filter((c) => c.url === FCM_URL)).toHaveLength(2);
  });
});

describe('fcmTransport failures', () => {
  it.each([
    ['network error', new TypeError('fetch failed: secret'), 'NETWORK'],
    ['timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'TIMEOUT'],
  ])('%s on send is retryable', async (_, err, code) => {
    const f = fakeFetch([err as Error]);
    expect(await fcmTransport(config, { fetch: f.fetch }).send(msg)).toEqual({
      ok: false,
      kind: 'retryable',
      errorCode: code,
    });
  });

  it('OAuth rejection (4xx) is config-fatal; OAuth 5xx and network errors are retryable', async () => {
    const reject = fakeFetch([], [json(400, { error: 'invalid_grant', error_description: SECRET_DESC })]);
    expect(await fcmTransport(config, { fetch: reject.fetch }).send(msg)).toEqual({
      ok: false,
      kind: 'config',
      errorCode: 'OAUTH_REJECTED',
    });
    const down = fakeFetch([], [json(503, {})]);
    expect(await fcmTransport(config, { fetch: down.fetch }).send(msg)).toMatchObject({
      kind: 'retryable',
      errorCode: 'OAUTH_UNAVAILABLE',
    });
    const net = fakeFetch([], [new TypeError('boom')]);
    expect(await fcmTransport(config, { fetch: net.fetch }).send(msg)).toMatchObject({
      kind: 'retryable',
      errorCode: 'NETWORK',
    });
  });

  it('an unusable private key is config-fatal and nothing is fetched', async () => {
    const f = fakeFetch([]);
    const t = fcmTransport({ ...config, privateKey: 'not a key' }, { fetch: f.fetch });
    expect(await t.send(msg)).toEqual({ ok: false, kind: 'config', errorCode: 'BAD_PRIVATE_KEY' });
    expect(f.calls).toEqual([]);
  });

  it('classifies a real FCM response through send', async () => {
    const f = fakeFetch([json(404, fcmErr('NOT_FOUND', 'UNREGISTERED'))]);
    expect(await fcmTransport(config, { fetch: f.fetch }).send(msg)).toEqual({
      ok: false,
      kind: 'unregistered',
      errorCode: 'UNREGISTERED',
    });
  });
});

const SECRET_DESC = 'Invalid JWT Signature for key SECRET';

describe('classifyFcmError (error detail, never HTTP status alone)', () => {
  const NOW = 1_800_000_000_000;
  it.each([
    // [label, status, body, retry-after, expected]
    [
      'UNREGISTERED → prune',
      404,
      fcmErr('NOT_FOUND', 'UNREGISTERED'),
      null,
      { kind: 'unregistered', errorCode: 'UNREGISTERED' },
    ],
    [
      'INVALID_ARGUMENT + message.token violation → prune',
      400,
      fcmErr('INVALID_ARGUMENT', 'INVALID_ARGUMENT', [tokenViolation]),
      null,
      { kind: 'unregistered', errorCode: 'INVALID_ARGUMENT' },
    ],
    [
      'INVALID_ARGUMENT via google.rpc status + token violation → prune',
      400,
      fcmErr('INVALID_ARGUMENT', undefined, [tokenViolation]),
      null,
      { kind: 'unregistered', errorCode: 'INVALID_ARGUMENT' },
    ],
    [
      'INVALID_ARGUMENT on another field → fatal, no prune',
      400,
      fcmErr('INVALID_ARGUMENT', 'INVALID_ARGUMENT', [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.data' }],
        },
      ]),
      null,
      { kind: 'fatal', errorCode: 'INVALID_ARGUMENT' },
    ],
    [
      'INVALID_ARGUMENT without violations → fatal',
      400,
      fcmErr('INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
      null,
      { kind: 'fatal', errorCode: 'INVALID_ARGUMENT' },
    ],
    [
      'SENDER_ID_MISMATCH → config',
      403,
      fcmErr('PERMISSION_DENIED', 'SENDER_ID_MISMATCH'),
      null,
      { kind: 'config', errorCode: 'SENDER_ID_MISMATCH' },
    ],
    [
      'PERMISSION_DENIED (rpc status only) → config',
      403,
      fcmErr('PERMISSION_DENIED'),
      null,
      { kind: 'config', errorCode: 'PERMISSION_DENIED' },
    ],
    [
      'UNAUTHENTICATED → config',
      401,
      fcmErr('UNAUTHENTICATED'),
      null,
      { kind: 'config', errorCode: 'UNAUTHENTICATED' },
    ],
    [
      'QUOTA_EXCEEDED honours Retry-After',
      429,
      fcmErr('RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'),
      '120',
      { kind: 'retryable', errorCode: 'QUOTA_EXCEEDED', retryAfterMs: 120_000 },
    ],
    [
      'UNAVAILABLE → retryable',
      503,
      fcmErr('UNAVAILABLE', 'UNAVAILABLE'),
      null,
      { kind: 'retryable', errorCode: 'UNAVAILABLE' },
    ],
    [
      'INTERNAL → retryable',
      500,
      fcmErr('INTERNAL', 'INTERNAL'),
      null,
      { kind: 'retryable', errorCode: 'INTERNAL' },
    ],
    [
      'DEADLINE_EXCEEDED → retryable',
      504,
      fcmErr('DEADLINE_EXCEEDED'),
      null,
      { kind: 'retryable', errorCode: 'DEADLINE_EXCEEDED' },
    ],
    ['ABORTED → retryable', 409, fcmErr('ABORTED'), null, { kind: 'retryable', errorCode: 'ABORTED' }],
    [
      'FcmError code wins over the rpc status',
      400,
      fcmErr('INVALID_ARGUMENT', 'UNREGISTERED'),
      null,
      { kind: 'unregistered', errorCode: 'UNREGISTERED' },
    ],
    [
      '404 NOT_FOUND without an FcmError is not a prune',
      404,
      fcmErr('NOT_FOUND'),
      null,
      { kind: 'fatal', errorCode: 'NOT_FOUND' },
    ],
    ['a 404 with no detail at all is not a prune', 404, null, null, { kind: 'fatal', errorCode: 'HTTP_404' }],
    [
      'a 502 HTML page (no detail) → retryable',
      502,
      null,
      null,
      { kind: 'retryable', errorCode: 'HTTP_502' },
    ],
    [
      'a 429 with no detail honours Retry-After',
      429,
      null,
      '7',
      { kind: 'retryable', errorCode: 'HTTP_429', retryAfterMs: 7000 },
    ],
    [
      'an unknown code → fatal with that code',
      400,
      fcmErr('FAILED_PRECONDITION', 'APNS_AUTH_ERROR'),
      null,
      { kind: 'fatal', errorCode: 'APNS_AUTH_ERROR' },
    ],
    [
      'a code that is not enum-shaped never reaches last_error',
      400,
      fcmErr(`bad ${FCM_TOKEN}`, `x ${FCM_TOKEN}`),
      null,
      { kind: 'fatal', errorCode: 'HTTP_400' },
    ],
  ] as const)('%s', (_, status, body, retryAfter, expected) => {
    const r = classifyFcmError(status, body, retryAfter, NOW);
    expect(r).toEqual({ ok: false, ...expected });
    expect(JSON.stringify(r)).not.toContain(FCM_TOKEN);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates, ignores junk', () => {
    const now = Date.parse('2026-11-24T09:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Tue, 24 Nov 2026 09:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('fakeTransport', () => {
  it('records messages, plays scripted results per token, then succeeds', async () => {
    const t = fakeTransport();
    t.script(FCM_TOKEN, { ok: false, kind: 'retryable', errorCode: 'UNAVAILABLE' });
    expect(await t.send(msg)).toMatchObject({ ok: false, kind: 'retryable' });
    expect(await t.send(msg)).toEqual({ ok: true });
    expect(await t.send({ ...msg, token: 'other' })).toEqual({ ok: true });
    expect(t.sent).toHaveLength(3);
  });

  it('with log, prints the type and registration id but never the token', async () => {
    await fakeTransport({ log: true }).send(msg);
    expect(logs).toEqual([['[push:fake] sent type=push.test registration=reg-1']]);
    logs.length = 0; // satisfy the no-logs afterEach for this deliberate case
  });
});
