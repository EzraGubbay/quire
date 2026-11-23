// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushConfig } from './config';
import { backoffMs, dispatchDue, MAX_ATTEMPTS, sendTestPush } from './dispatcher';
import { filesAdded, noteSynthesized } from './events';
import { memoryPushStore } from './memory-store';
import { enqueuePush, type OutboxStore } from './outbox';
import { type FakeTransport, fakeTransport, type SendResult } from './transport';

const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const t0 = new Date('2026-11-24T09:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const MIN = 60_000;
const course = { courseSlug: 'signals', courseId: 'c-1' };
const file = (n: number) => filesAdded({ ...course, fileId: `doc-${n}`, lemidaFileId: `lf-${n}` });
const note = (n: number) =>
  noteSynthesized({ ...course, noteId: `n-${n}`, outcome: 'ready', noteUpdatedAt: t0 });

const retryable: SendResult = { ok: false, kind: 'retryable', errorCode: 'UNAVAILABLE' };

let m: ReturnType<typeof memoryPushStore>;
let fake: FakeTransport;
let reg: { id: string; fcmToken: string };
let logs: unknown[][];

beforeEach(async () => {
  m = memoryPushStore();
  fake = fakeTransport();
  const d = m.addDevice('local');
  reg = await m.registrations.upsert(
    d.id,
    {
      fcmToken: 'fcm-A',
      platform: 'android',
      appVersion: '1.1.0',
      categories: ['files', 'deadlines', 'notes'],
    },
    t0,
  );
  logs = [];
  for (const k of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => {
  expect(JSON.stringify(logs)).not.toContain('fcm-A'); // FCM tokens never reach logs
  vi.restoreAllMocks();
});

const enqueue = (e: ReturnType<typeof file>, now: Date) =>
  enqueuePush(['local'], e, { store: m.outbox, config: enabled, now });
const dispatch = (now: Date, store: OutboxStore = m.outbox) =>
  dispatchDue(now, { store, transport: fake, clock: () => now });

describe('dispatchDue: single events', () => {
  it('sends a due row as a one-row batch with eventId = batch_id and marks it sent', async () => {
    await enqueue(note(1), t0);
    const s = await dispatch(t0);
    expect(s).toMatchObject({ batches: 1, sent: 1 });
    const [sent] = fake.sent;
    const row = m.rows[0];
    expect(row?.batchId).toBeTruthy();
    expect(sent?.data.eventId).toBe(row?.batchId);
    expect(sent).toMatchObject({
      token: 'fcm-A',
      priority: 'NORMAL',
      ttlSeconds: 86_400,
      registrationId: reg.id,
    });
    expect(sent?.data).not.toHaveProperty('count');
    expect(row?.sentAt).toEqual(t0);
    expect(m.regs[0]?.lastSentAt).toEqual(t0);
    expect((await dispatch(at(MIN)))?.batches).toBe(0); // never resent
  });

  it('does not send rows that are not yet due', async () => {
    await enqueue(file(1), t0); // coalescing: due at +90 s
    expect((await dispatch(at(60_000)))?.batches).toBe(0);
    expect(fake.sent).toEqual([]);
  });

  it('marks expired rows dead individually instead of sending them', async () => {
    await enqueue(note(1), t0);
    await enqueue(note(2), at(1000));
    const late = at(86_400_000 + 500); // note 1 expired, note 2 still live
    const s = await dispatch(late);
    expect(s).toMatchObject({ expired: 1, sent: 1 });
    expect(m.rows[0]).toMatchObject({ deadAt: late, lastError: 'expired', sentAt: null });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.ttlSeconds).toBe(0);
  });
});

describe('dispatchDue: batch freeze (ADR 0003 §1)', () => {
  it('a burst of three files becomes one message with count 3 and the newest fileId', async () => {
    for (const [i, ms] of [0, 20_000, 40_000].entries()) await enqueue(file(i + 1), at(ms));
    const s = await dispatch(at(5 * MIN));
    expect(s).toMatchObject({ batches: 1, sent: 1 });
    expect(fake.sent[0]?.data).toMatchObject({ type: 'files.added', count: '3', fileId: 'doc-3' });
    const batchIds = new Set(m.rows.map((r) => r.batchId));
    expect(batchIds.size).toBe(1);
    expect(fake.sent[0]?.data.eventId).toBe([...batchIds][0]);
  });

  it('a retry resends the same frozen batch: same eventId, count and fileId; late rows wait, then form the next batch', async () => {
    await enqueue(file(1), t0);
    await enqueue(file(2), at(10_000));
    fake.script('fcm-A', { ...retryable, retryAfterMs: 5 * MIN });
    const first = await dispatch(at(2 * MIN));
    expect(first).toMatchObject({ retried: 1, sent: 0 });
    const frozen = fake.sent[0]?.data;
    expect(frozen).toMatchObject({ count: '2', fileId: 'doc-2' });

    // A file arrives while the batch awaits its retry: it is not added to the frozen batch…
    await enqueue(file(3), at(2 * MIN + 1000));
    // …and even once due, it waits behind the pending batch.
    const held = await dispatch(at(2 * MIN + 1000 + 91_000));
    expect(held?.held).toBe(1);
    expect(fake.sent).toHaveLength(1);

    const second = await dispatch(at(7 * MIN + 1));
    expect(second?.sent).toBe(1);
    expect(fake.sent[1]?.data).toEqual(frozen); // byte-identical payload: eventId, count, fileId

    const third = await dispatch(at(10 * MIN));
    expect(third?.sent).toBe(1);
    expect(fake.sent[2]?.data).toMatchObject({ count: '1', fileId: 'doc-3' });
    expect(fake.sent[2]?.data.eventId).not.toBe(frozen?.eventId);
  });

  it('marks rows by batch id, never by group: a newer unbatched row of the group stays pending', async () => {
    await enqueue(file(1), t0);
    fake.script('fcm-A', retryable);
    await dispatch(at(2 * MIN));
    await enqueue(file(2), at(2 * MIN + 1));
    await dispatch(at(2 * MIN + backoffMs(1) + 1)); // retry of batch 1 succeeds; file 2 is held this pass
    const [r1, r2] = m.rows;
    expect(r1?.sentAt).toBeTruthy();
    expect(r2).toMatchObject({ sentAt: null, deadAt: null, batchId: null });
  });

  it('loads a retried batch by batch_id, not from the limited due selection', async () => {
    for (let i = 1; i <= 4; i++) await enqueue(file(i), at(i * 1000));
    fake.script('fcm-A', retryable);
    await dispatch(at(5 * MIN));
    // Simulate the due LIMIT cutting the batch: only one of its rows is selected.
    const limited: OutboxStore = {
      ...m.outbox,
      due: async (now, limit) => (await m.outbox.due(now, limit)).slice(0, 1),
    };
    await dispatch(at(5 * MIN + backoffMs(1) + 1), limited);
    expect(fake.sent[1]?.data.count).toBe('4');
    expect(m.rows.every((r) => r.sentAt)).toBe(true);
  });

  it('recomputes the TTL from the earliest expires_at on every attempt', async () => {
    await enqueue(file(1), t0);
    await enqueue(file(2), at(30_000));
    fake.script('fcm-A', retryable);
    await dispatch(at(2 * MIN));
    const retryAt = at(2 * MIN + backoffMs(1) + 1);
    await dispatch(retryAt);
    const earliest = t0.getTime() + 7 * 86_400_000;
    expect(fake.sent[0]?.ttlSeconds).toBe(Math.floor((earliest - at(2 * MIN).getTime()) / 1000));
    expect(fake.sent[1]?.ttlSeconds).toBe(Math.floor((earliest - retryAt.getTime()) / 1000));
  });

  it('drops a batch row that expired while awaiting retry, and sends the rest', async () => {
    await enqueue(note(1), t0);
    fake.script('fcm-A', { ...retryable, retryAfterMs: 2 * 86_400_000 });
    await dispatch(t0);
    const later = at(2 * 86_400_000 + 1);
    const s = await dispatch(later);
    expect(s).toMatchObject({ expired: 1, batches: 0 });
    expect(m.rows[0]).toMatchObject({ lastError: 'expired' });
    expect(fake.sent).toHaveLength(1);
  });
});

describe('dispatchDue: outcomes (ADR 0003 §3.4)', () => {
  it('UNREGISTERED prunes the registration; its pending rows cascade', async () => {
    await enqueue(note(1), t0);
    await enqueue(note(2), at(1));
    fake.script('fcm-A', { ok: false, kind: 'unregistered', errorCode: 'UNREGISTERED' });
    const s = await dispatch(at(MIN));
    expect(s?.pruned).toBe(1);
    expect(m.regs).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(logs).toContainEqual([`[push] pruned registration ${reg.id}`]);
  });

  it('config-fatal marks the batch dead, keeps the registration and logs once per process', async () => {
    await enqueue(note(1), t0);
    await enqueue(note(2), t0);
    const cfg: SendResult = { ok: false, kind: 'config', errorCode: 'SENDER_ID_MISMATCH' };
    fake.script('fcm-A', cfg, cfg);
    await dispatch(at(MIN));
    expect(m.rows.every((r) => r.deadAt && r.lastError === 'SENDER_ID_MISMATCH')).toBe(true);
    expect(m.regs[0]).toMatchObject({ id: reg.id, lastError: null }); // config-fatal is not the device's fault
    const configLogs = logs.filter((l) => String(l[0]).includes('FCM config error: SENDER_ID_MISMATCH'));
    expect(configLogs.length).toBeLessThanOrEqual(1);
  });

  it('retryable backs off 30 s · 2^n, honours Retry-After, and gives up after 6 attempts', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
    ]);
    expect(backoffMs(1, 10 * MIN)).toBe(10 * MIN);

    await enqueue(note(1), t0);
    let now = t0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      fake.script('fcm-A', retryable);
      await dispatch(now);
      expect(m.rows[0]).toMatchObject({ attempts: i, deadAt: null });
      now = new Date(m.rows[0]?.notBefore.getTime() as number);
      expect(now.getTime()).toBeGreaterThan(t0.getTime());
    }
    fake.script('fcm-A', retryable);
    await dispatch(now);
    expect(m.rows[0]).toMatchObject({ lastError: 'UNAVAILABLE' });
    expect(m.rows[0]?.deadAt).toBeTruthy();
    expect(fake.sent).toHaveLength(MAX_ATTEMPTS);
    expect(m.regs).toHaveLength(1);
  });

  it('a Retry-After longer than the backoff sets not_before', async () => {
    await enqueue(note(1), t0);
    fake.script('fcm-A', { ...retryable, retryAfterMs: 15 * MIN });
    await dispatch(t0);
    expect(m.rows[0]?.notBefore).toEqual(at(15 * MIN));
  });

  it('any other error is fatal: dead with the code, registration kept', async () => {
    await enqueue(note(1), t0);
    fake.script('fcm-A', { ok: false, kind: 'fatal', errorCode: 'INVALID_ARGUMENT' });
    await dispatch(t0);
    expect(m.rows[0]).toMatchObject({ lastError: 'INVALID_ARGUMENT' });
    expect(m.regs[0]?.lastError).toBe('INVALID_ARGUMENT');
  });

  it('a throwing transport counts as retryable', async () => {
    await enqueue(note(1), t0);
    const boom = { send: async () => Promise.reject(new Error('fcm-A exploded')) };
    await dispatchDue(t0, { store: m.outbox, transport: boom, clock: () => t0 });
    expect(m.rows[0]).toMatchObject({ attempts: 1, deadAt: null });
  });

  it.each(['NETWORK', 'TIMEOUT', 'OAUTH_UNAVAILABLE', 'OAUTH_REJECTED'])(
    'a %s failure ends the pass; the remaining batches go out next pass',
    async (code) => {
      await enqueue(note(1), t0);
      await enqueue(note(2), at(1));
      fake.script('fcm-A', {
        ok: false,
        kind: code === 'OAUTH_REJECTED' ? 'config' : 'retryable',
        errorCode: code,
      });
      const s = await dispatch(at(MIN));
      expect(s).toMatchObject({ aborted: true, batches: 1 });
      expect(fake.sent).toHaveLength(1);
      const untouched = m.rows[1];
      expect(untouched).toMatchObject({ sentAt: null, deadAt: null, attempts: 0 });
      expect(untouched?.batchId).toBeTruthy(); // frozen this pass, sent as-is next pass
      const next = await dispatch(at(2 * MIN));
      expect(next?.sent).toBeGreaterThanOrEqual(1);
      expect(fake.sent.slice(1).map((x) => x.data.eventId)).toContain(untouched?.batchId);
      expect(untouched?.sentAt).toEqual(at(2 * MIN));
    },
  );

  it('an ordinary per-device failure does not end the pass', async () => {
    await enqueue(note(1), t0);
    await enqueue(note(2), at(1));
    fake.script('fcm-A', { ok: false, kind: 'retryable', errorCode: 'UNAVAILABLE' });
    const s = await dispatch(at(MIN));
    expect(s).toMatchObject({ aborted: false, batches: 2, retried: 1, sent: 1 });
  });

  it('takes a fresh clock reading per batch for TTL and bookkeeping', async () => {
    await enqueue(note(1), t0);
    await enqueue(note(2), t0);
    const times = [at(MIN), at(MIN + 5_000)];
    await dispatchDue(at(MIN), { store: m.outbox, transport: fake, clock: () => times.shift() ?? at(MIN) });
    expect(fake.sent.map((x) => x.ttlSeconds)).toEqual([86_400 - 60, 86_400 - 65]);
    expect(m.rows.map((r) => r.sentAt)).toEqual([at(MIN), at(MIN + 5_000)]);
  });

  it('never sends to a revoked device', async () => {
    await enqueue(note(1), t0);
    m.revoke(m.regs[0]?.tokenId as string);
    await dispatch(at(MIN));
    expect(fake.sent).toEqual([]);
    expect(m.rows).toEqual([]);
  });

  it('runs one pass at a time', async () => {
    await enqueue(note(1), t0);
    let release!: () => void;
    const slow = { send: () => new Promise<SendResult>((r) => (release = () => r({ ok: true }))) };
    const a = dispatchDue(t0, { store: m.outbox, transport: slow, clock: () => t0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(await dispatchDue(t0, { store: m.outbox, transport: slow, clock: () => t0 })).toBeNull();
    release();
    expect((await a)?.sent).toBe(1);
  });
});

describe('sendTestPush (synchronous POST /push/test)', () => {
  it('sent: records a single-row batch that is terminal from the start and is never resent', async () => {
    const r = await sendTestPush(reg, { store: m.outbox, transport: fake, now: t0, eventId: 'e-1' });
    expect(r).toEqual({ eventId: 'e-1', outcome: 'sent' });
    expect(fake.sent[0]).toMatchObject({
      token: 'fcm-A',
      priority: 'HIGH',
      ttlSeconds: 300,
      collapseKey: 'push.test',
      data: { v: '1', type: 'push.test', eventId: 'e-1' },
    });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ dedupeKey: 'push.test:e-1', batchId: 'e-1', sentAt: t0 });
    await dispatch(at(MIN));
    await dispatch(at(10 * MIN));
    expect(fake.sent).toHaveLength(1);
  });

  it('retryable and failed: reported, recorded dead, nothing queued', async () => {
    fake.script('fcm-A', retryable, { ok: false, kind: 'config', errorCode: 'PERMISSION_DENIED' });
    expect((await sendTestPush(reg, { store: m.outbox, transport: fake, now: t0 })).outcome).toBe(
      'retryable',
    );
    expect((await sendTestPush(reg, { store: m.outbox, transport: fake, now: t0 })).outcome).toBe('failed');
    expect(m.rows.map((r) => [r.deadAt, r.lastError])).toEqual([
      [t0, 'UNAVAILABLE'],
      [t0, 'PERMISSION_DENIED'],
    ]);
    await dispatch(at(MIN));
    expect(fake.sent).toHaveLength(2);
    expect(m.regs).toHaveLength(1);
  });

  it('unregistered: the registration is already deleted when the response goes out', async () => {
    fake.script('fcm-A', { ok: false, kind: 'unregistered', errorCode: 'UNREGISTERED' });
    expect((await sendTestPush(reg, { store: m.outbox, transport: fake, now: t0 })).outcome).toBe(
      'unregistered',
    );
    expect(m.regs).toEqual([]);
  });

  it('a bookkeeping failure does not change the reported outcome', async () => {
    const store = { ...m.outbox, insert: async () => Promise.reject(new Error('db down')) } as OutboxStore;
    expect((await sendTestPush(reg, { store, transport: fake, now: t0 })).outcome).toBe('sent');
  });
});
