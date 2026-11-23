// @vitest-environment node
// files.added coalescing end to end (ADR 0003 §1): imports go through the real trigger, the outbox slide and the
// dispatcher, against the in-memory store and the fake transport.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushConfig } from './config';
import { dispatchDue } from './dispatcher';
import { memoryPushStore } from './memory-store';
import { COALESCE_CAP_MS, COALESCE_DELAY_MS, enqueuePush } from './outbox';
import { type FakeTransport, fakeTransport } from './transport';
import { notifyFilesAdded, type TriggerDeps } from './triggers';

const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const t0 = new Date('2026-11-24T09:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const S = 1000;
const COURSE_ID = 'c-1';

let m: ReturnType<typeof memoryPushStore>;
let fake: FakeTransport;
let clock: Date;
let deps: TriggerDeps;

async function device(token: string) {
  const d = m.addDevice('local');
  return m.registrations.upsert(
    d.id,
    { fcmToken: token, platform: 'android', appVersion: '1.1.0', categories: ['files'] },
    t0,
  );
}

/** One Lemida import of file `n` at `now`. */
async function importFile(n: number, now: Date) {
  clock = now;
  await notifyFilesAdded(
    COURSE_ID,
    { status: 'imported', duplicate: false, lemidaFileId: `lf-${n}`, placement: { documentId: `doc-${n}` } },
    deps,
  );
}

const dispatch = (now: Date) => dispatchDue(now, { store: m.outbox, transport: fake, clock: () => now });

beforeEach(() => {
  m = memoryPushStore();
  fake = fakeTransport();
  clock = t0;
  deps = {
    config: enabled,
    course: async () => ({ slug: 'signals', kind: 'course', status: 'active' }),
    registeredOwners: async () => ['local'],
    enqueue: (audience, event, now) =>
      enqueuePush(audience, event, { store: m.outbox, config: enabled, now }),
    now: () => clock,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('files.added coalescing', () => {
  it('a burst of 5 imports dispatches exactly one message per device: count=5, newest fileId', async () => {
    await device('fcm-A');
    await device('fcm-B');
    for (let i = 1; i <= 5; i++) await importFile(i, at(i * 10 * S));

    // The last import slid the group to 50 s + 90 s; nothing is due before that.
    expect((await dispatch(at(139 * S)))?.batches).toBe(0);
    await dispatch(at(140 * S));

    expect(fake.sent).toHaveLength(2);
    expect(fake.sent.map((s) => s.token).sort()).toEqual(['fcm-A', 'fcm-B']);
    for (const s of fake.sent)
      expect(s.data).toMatchObject({ type: 'files.added', count: '5', fileId: 'doc-5' });
    expect(m.rows.every((r) => r.sentAt)).toBe(true);
    expect((await dispatch(at(600 * S)))?.batches).toBe(0);
  });

  it('a single file notifies 90 s after its import', async () => {
    await device('fcm-A');
    await importFile(1, t0);
    expect(m.rows[0]?.notBefore).toEqual(at(COALESCE_DELAY_MS));
    await dispatch(at(COALESCE_DELAY_MS));
    expect(fake.sent[0]?.data).toMatchObject({ count: '1', fileId: 'doc-1' });
  });

  it('a steady trickle is capped at 10 min after the first import; a row past the cap forms the next batch', async () => {
    await device('fcm-A');
    for (let i = 0; i < 10; i++) await importFile(i, at(i * 60 * S)); // one a minute, 0–9 min
    // Every older row is held at the cap; the newest starts at its own now + 90 s, which is past it.
    for (const r of m.rows.slice(0, 9)) expect(r.notBefore).toEqual(at(COALESCE_CAP_MS));
    expect(m.rows[9]?.notBefore).toEqual(at(9 * 60 * S + COALESCE_DELAY_MS));
    await dispatch(at(COALESCE_CAP_MS));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.data).toMatchObject({ count: '9', fileId: 'doc-8' });
    await dispatch(at(9 * 60 * S + COALESCE_DELAY_MS));
    expect(fake.sent[1]?.data).toMatchObject({ count: '1', fileId: 'doc-9' });
  });

  it('the slide never lowers not_before', async () => {
    await device('fcm-A');
    await importFile(1, t0);
    const first = m.rows[0];
    if (!first) throw new Error('no row');
    first.notBefore = at(3600 * S); // e.g. pushed out by something else; never pulled back
    await importFile(2, at(10 * S));
    expect(first.notBefore).toEqual(at(3600 * S));
    expect(m.rows[1]?.notBefore).toEqual(at(100 * S));
  });

  it('a row arriving during a retry joins the next batch and does not shorten the backoff', async () => {
    const reg = await device('fcm-A');
    await importFile(1, t0);
    await importFile(2, at(5 * S));
    fake.script(reg.fcmToken, { ok: false, kind: 'retryable', errorCode: 'UNAVAILABLE' });
    await dispatch(at(95 * S)); // batch [1, 2] frozen and failed → retry in 30 s
    const frozen = m.rows.filter((r) => r.batchId);
    expect(frozen).toHaveLength(2);
    const retryAt = frozen[0]?.notBefore as Date;
    expect(retryAt).toEqual(at(125 * S));

    await importFile(3, at(100 * S)); // during the retry window
    expect(m.rows.filter((r) => r.batchId).map((r) => r.notBefore)).toEqual([retryAt, retryAt]);
    expect(m.rows[2]).toMatchObject({ batchId: null, notBefore: at(190 * S) });

    await dispatch(at(125 * S)); // the retry resends exactly the frozen batch
    expect(fake.sent[1]?.data).toEqual(fake.sent[0]?.data);
    expect(fake.sent[1]?.data).toMatchObject({ count: '2', fileId: 'doc-2' });

    await dispatch(at(190 * S)); // the late row is its own, newer batch
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.data).toMatchObject({ count: '1', fileId: 'doc-3' });
    expect(fake.sent[2]?.data.eventId).not.toBe(fake.sent[0]?.data.eventId);
  });
});
