// @vitest-environment node
// The real /push/* handlers end to end against the in-memory stores and the fake transport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureLimiter } from '../rate-limit';
import { ErrorEnvelope, PushRegistrationState, PutPushRegistrationResponse, TestPushResult } from '../schema';
import { type PushApiDeps, pushHandlers, TEST_PUSH_WINDOW_MS } from './api';
import type { PushConfig } from './config';
import { dispatchDue } from './dispatcher';
import { filesAdded } from './events';
import { memoryPushStore } from './memory-store';
import { enqueuePush } from './outbox';
import { type FakeTransport, fakeTransport } from './transport';

const FCM = 'fcm-token-SECRET-abc';
const t0 = new Date('2026-11-24T09:00:00.000Z');

let m: ReturnType<typeof memoryPushStore>;
let fake: FakeTransport;
let config: PushConfig;
let now: Date;
let h: ReturnType<typeof pushHandlers>;
let logs: unknown[][];

beforeEach(() => {
  m = memoryPushStore();
  fake = fakeTransport();
  config = { enabled: true, transport: 'fake' };
  now = t0;
  const deps: PushApiDeps = {
    auth: m.auth,
    registrations: m.registrations,
    outbox: m.outbox,
    config: () => config,
    transport: () => (config.enabled ? fake : null),
    testLimiter: new FailureLimiter(1, TEST_PUSH_WINDOW_MS),
    now: () => now,
  };
  h = pushHandlers(() => deps);
  logs = [];
  for (const k of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => {
  expect(JSON.stringify(logs)).not.toContain(FCM);
  vi.restoreAllMocks();
});

const URL_REG = 'http://x/api/mobile/v1/push/registration';
const URL_TEST = 'http://x/api/mobile/v1/push/test';
const req = (method: string, url: string, bearer?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const goodBody = (over: object = {}) => ({
  fcmToken: FCM,
  platform: 'android',
  appVersion: '1.1.0',
  categories: ['files', 'deadlines', 'notes'],
  ...over,
});
const put = (bearer: string, body: unknown = goodBody()) =>
  h.putRegistration(req('PUT', URL_REG, bearer, body));
const get = (bearer: string) => h.getRegistration(req('GET', URL_REG, bearer));
const del = (bearer: string) => h.deleteRegistration(req('DELETE', URL_REG, bearer));
const test = (bearer: string) => h.sendTest(req('POST', URL_TEST, bearer));

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(ErrorEnvelope.parse(body).error.code).toBe(code);
  expect(JSON.stringify(body)).not.toContain(FCM);
}

describe('auth', () => {
  it('every push operation answers 401 without a valid, unrevoked device token', async () => {
    const d = m.addDevice();
    m.revoke(d.id);
    for (const bearer of [undefined, 'nope', d.bearer]) {
      for (const res of [
        await h.putRegistration(req('PUT', URL_REG, bearer, goodBody())),
        await h.getRegistration(req('GET', URL_REG, bearer)),
        await h.deleteRegistration(req('DELETE', URL_REG, bearer)),
        await h.sendTest(req('POST', URL_TEST, bearer)),
      ]) {
        await expectError(res, 401, 'unauthorized');
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      }
    }
  });
});

describe('PUT /push/registration', () => {
  it('registers the calling device and never echoes the FCM token', async () => {
    const d = m.addDevice();
    const res = await put(d.bearer);
    expect(res.status).toBe(200);
    const body = PutPushRegistrationResponse.parse(await res.json());
    expect(body).toEqual({
      registration: {
        deviceId: d.id,
        platform: 'android',
        appVersion: '1.1.0',
        categories: ['files', 'deadlines', 'notes'],
        createdAt: t0.toISOString(),
        updatedAt: t0.toISOString(),
      },
      pushEnabled: true,
    });
    expect(JSON.stringify(body)).not.toContain(FCM);
    expect(m.regs[0]?.fcmToken).toBe(FCM);
  });

  it('is idempotent: the same body yields the same state, updatedAt included', async () => {
    const d = m.addDevice();
    const first = await (await put(d.bearer)).json();
    now = new Date(t0.getTime() + 60_000);
    const second = await (await put(d.bearer)).json();
    expect(second).toEqual(first);
    expect(m.regs).toHaveLength(1);
  });

  it('a changed body bumps updatedAt, keeps createdAt', async () => {
    const d = m.addDevice();
    await put(d.bearer);
    now = new Date(t0.getTime() + 60_000);
    const res = PutPushRegistrationResponse.parse(
      await (await put(d.bearer, goodBody({ categories: ['files'] }))).json(),
    );
    expect(res.registration).toMatchObject({
      categories: ['files'],
      createdAt: t0.toISOString(),
      updatedAt: now.toISOString(),
    });
  });

  it('ignores unknown categories and collapses duplicates; appVersion is optional', async () => {
    const d = m.addDevice();
    const body = goodBody({ categories: ['notes', 'chat', 'files', 'notes'], appVersion: undefined });
    const res = PutPushRegistrationResponse.parse(await (await put(d.bearer, body)).json());
    expect(res.registration.categories).toEqual(['files', 'notes']);
    expect(res.registration.appVersion).toBeNull();
    expect((await put(d.bearer, goodBody({ categories: [] }))).status).toBe(200);
  });

  it('moves an FCM token registered under another device to the caller', async () => {
    const a = m.addDevice();
    const b = m.addDevice();
    await put(a.bearer);
    await put(b.bearer);
    expect(m.regs.map((r) => r.tokenId)).toEqual([b.id]);
    expect(PushRegistrationState.parse(await (await get(a.bearer)).json()).registration).toBeNull();
  });

  it('accepts an FCM token of exactly 1024 characters', async () => {
    const d = m.addDevice();
    const res = await put(d.bearer, goodBody({ fcmToken: 't'.repeat(1024) }));
    expect(res.status).toBe(200);
  });

  it('reports pushEnabled false when push is disabled, but still stores the registration', async () => {
    config = { enabled: false, reason: 'missing' };
    const d = m.addDevice();
    const body = PutPushRegistrationResponse.parse(await (await put(d.bearer)).json());
    expect(body.pushEnabled).toBe(false);
    expect(m.regs).toHaveLength(1);
  });

  it.each([
    ['a non-JSON body', '{nope'],
    ['a missing fcmToken', { platform: 'android', categories: [] }],
    ['an empty fcmToken', goodBody({ fcmToken: '' })],
    ['an oversized fcmToken (> 1024)', goodBody({ fcmToken: `${FCM}${'x'.repeat(1025 - FCM.length)}` })],
    ['an unknown platform', goodBody({ platform: 'ios' })],
    ['a long appVersion', goodBody({ appVersion: 'v'.repeat(33) })],
    ['missing categories', { fcmToken: FCM, platform: 'android' }],
    ['non-string categories', goodBody({ categories: [1] })],
  ])('400 invalid_request for %s, without echoing the token', async (_, body) => {
    const d = m.addDevice();
    await expectError(await put(d.bearer, body), 400, 'invalid_request');
    expect(m.regs).toEqual([]);
  });

  it('an unexpected store error answers 500 internal and logs only the SQLSTATE', async () => {
    const d = m.addDevice();
    const broken = pushHandlers(() => ({
      auth: m.auth,
      registrations: {
        ...m.registrations,
        upsert: async () => {
          throw Object.assign(new Error(`duplicate key (fcm_token)=(${FCM})`), {
            code: '23505',
            detail: FCM,
          });
        },
      },
      outbox: m.outbox,
      config: () => config,
      transport: () => fake,
      testLimiter: new FailureLimiter(1, TEST_PUSH_WINDOW_MS),
      now: () => now,
    }));
    await expectError(
      await broken.putRegistration(req('PUT', URL_REG, d.bearer, goodBody())),
      500,
      'internal',
    );
    expect(logs).toContainEqual(['[push] PUT /push/registration failed (23505)']);
  });
});

describe('GET / DELETE /push/registration', () => {
  it('GET returns null before registering, the registration after', async () => {
    const d = m.addDevice();
    expect(PushRegistrationState.parse(await (await get(d.bearer)).json())).toEqual({
      registration: null,
      pushEnabled: true,
    });
    await put(d.bearer);
    const state = PushRegistrationState.parse(await (await get(d.bearer)).json());
    expect(state.registration?.deviceId).toBe(d.id);
  });

  it('DELETE answers 204 whether or not anything was registered, and removes pending rows', async () => {
    const d = m.addDevice();
    expect((await del(d.bearer)).status).toBe(204);
    await put(d.bearer);
    await enqueuePush(
      ['local'],
      filesAdded({ courseSlug: 's', courseId: 'c', fileId: 'f', lemidaFileId: 'l' }),
      {
        store: m.outbox,
        config: () => config,
        now: t0,
      },
    );
    expect(m.rows).toHaveLength(1);
    const res = await del(d.bearer);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(m.regs).toEqual([]);
    expect(m.rows).toEqual([]);
  });

  it('revoking the device deletes its registration and pending rows', async () => {
    const d = m.addDevice();
    await put(d.bearer);
    await enqueuePush(
      ['local'],
      filesAdded({ courseSlug: 's', courseId: 'c', fileId: 'f', lemidaFileId: 'l' }),
      {
        store: m.outbox,
        config: () => config,
        now: t0,
      },
    );
    m.revoke(d.id);
    expect(m.regs).toEqual([]);
    expect(m.rows).toEqual([]);
  });
});

describe('POST /push/test', () => {
  it('503 push_unavailable when push is disabled', async () => {
    config = { enabled: false, reason: 'bad_json' };
    const d = m.addDevice();
    await put(d.bearer);
    await expectError(await test(d.bearer), 503, 'push_unavailable');
    expect(fake.sent).toEqual([]);
  });

  it('400 invalid_request when the device has no registration', async () => {
    const d = m.addDevice();
    await expectError(await test(d.bearer), 400, 'invalid_request');
  });

  it('200 sent: delivered synchronously to the calling device only', async () => {
    const a = m.addDevice();
    const b = m.addDevice();
    await put(a.bearer);
    await put(b.bearer, goodBody({ fcmToken: 'other-device-token' }));
    const res = await test(a.bearer);
    expect(res.status).toBe(200);
    const body = TestPushResult.parse(await res.json());
    expect(body.outcome).toBe('sent');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ token: FCM, data: { type: 'push.test', eventId: body.eventId } });
    const row = m.rows.find((r) => r.dedupeKey === `push.test:${body.eventId}`);
    expect(row?.sentAt).toEqual(t0);
    const later = new Date(t0.getTime() + 600_000);
    await dispatchDue(later, { store: m.outbox, transport: fake, clock: () => later });
    expect(fake.sent).toHaveLength(1); // the recorded row is terminal: never resent
  });

  it('429 above one test per 30 s per device', async () => {
    const a = m.addDevice();
    const b = m.addDevice();
    await put(a.bearer);
    await put(b.bearer, goodBody({ fcmToken: 'b-token' }));
    expect((await test(a.bearer)).status).toBe(200);
    now = new Date(t0.getTime() + 29_000);
    await expectError(await test(a.bearer), 429, 'rate_limited');
    expect((await test(b.bearer)).status).toBe(200); // per device
    now = new Date(t0.getTime() + 30_001);
    expect((await test(a.bearer)).status).toBe(200);
  });

  it('reports unregistered (registration already pruned), retryable and failed', async () => {
    const d = m.addDevice();
    await put(d.bearer);
    fake.script(FCM, { ok: false, kind: 'retryable', errorCode: 'UNAVAILABLE' });
    expect(TestPushResult.parse(await (await test(d.bearer)).json()).outcome).toBe('retryable');
    now = new Date(now.getTime() + 31_000);
    fake.script(FCM, { ok: false, kind: 'fatal', errorCode: 'INVALID_ARGUMENT' });
    expect(TestPushResult.parse(await (await test(d.bearer)).json()).outcome).toBe('failed');
    now = new Date(now.getTime() + 31_000);
    fake.script(FCM, { ok: false, kind: 'unregistered', errorCode: 'UNREGISTERED' });
    expect(TestPushResult.parse(await (await test(d.bearer)).json()).outcome).toBe('unregistered');
    expect(PushRegistrationState.parse(await (await get(d.bearer)).json()).registration).toBeNull();
  });
});
