// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushConfig } from './config';
import { filesAdded, noteSynthesized, pushTest } from './events';
import { memoryPushStore } from './memory-store';
import { COALESCE_CAP_MS, COALESCE_DELAY_MS, enqueuePush, type OutboxStore } from './outbox';

const enabled = (): PushConfig => ({ enabled: true, transport: 'fake' });
const disabled = (): PushConfig => ({ enabled: false, reason: 'missing' });
const t0 = new Date('2026-11-24T09:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const course = { courseSlug: 'signals', courseId: 'c-1' };
const file = (n: number) => filesAdded({ ...course, fileId: `doc-${n}`, lemidaFileId: `lf-${n}` });
const note = noteSynthesized({ ...course, noteId: 'n-1', outcome: 'ready', noteUpdatedAt: t0 });

let m: ReturnType<typeof memoryPushStore>;
beforeEach(() => {
  m = memoryPushStore();
});
afterEach(() => vi.restoreAllMocks());

async function register(owner = 'local', categories = ['files', 'deadlines', 'notes'] as const) {
  const d = m.addDevice(owner);
  const reg = await m.registrations.upsert(
    d.id,
    { fcmToken: `fcm-${d.id}`, platform: 'android', appVersion: null, categories: [...categories] },
    t0,
  );
  return { device: d, reg };
}

describe('enqueuePush', () => {
  it('is a no-op when push is disabled', async () => {
    await register();
    expect(await enqueuePush(['local'], file(1), { store: m.outbox, config: disabled, now: t0 })).toBe(0);
    expect(m.rows).toEqual([]);
  });

  it('filters by category server-side, and skips revoked devices and owners outside the audience', async () => {
    const files = await register('local', ['files'] as never);
    const notesOnly = await register('local', ['notes'] as never);
    const revoked = await register('local');
    m.revoke(revoked.device.id);
    await register('someone-else');

    expect(await enqueuePush(['local'], file(1), { store: m.outbox, config: enabled, now: t0 })).toBe(1);
    expect(m.rows.map((r) => r.registrationId)).toEqual([files.reg.id]);
    expect(await enqueuePush(['local'], note, { store: m.outbox, config: enabled, now: t0 })).toBe(1);
    expect(m.rows.at(-1)?.registrationId).toBe(notesOnly.reg.id);
  });

  it('dedupes on (registration, dedupe_key)', async () => {
    await register();
    const deps = { store: m.outbox, config: enabled, now: t0 };
    expect(await enqueuePush(['local'], file(1), deps)).toBe(1);
    expect(await enqueuePush(['local'], file(1), { ...deps, now: at(5_000) })).toBe(0);
    expect(m.rows).toHaveLength(1);
  });

  it('stores the row with expires_at = now + TTL and no batch', async () => {
    await register();
    await enqueuePush(['local'], note, { store: m.outbox, config: enabled, now: t0 });
    expect(m.rows[0]).toMatchObject({
      type: 'note.synthesized',
      groupKey: null,
      batchId: null,
      notBefore: t0,
      expiresAt: at(86_400_000),
      priority: 'NORMAL',
      data: note.data,
    });
  });

  it('ignores push.test (no category: it is sent synchronously) and an empty audience', async () => {
    await register();
    expect(
      await enqueuePush(['local'], pushTest({ eventId: 'e' }), { store: m.outbox, config: enabled }),
    ).toBe(0);
    expect(await enqueuePush([], file(1), { store: m.outbox, config: enabled })).toBe(0);
    expect(m.rows).toEqual([]);
  });

  it('never throws into the caller, and logs no error message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = {
      ...m.outbox,
      targets: async () => {
        throw Object.assign(new Error('duplicate key value (fcm_token)=(SECRET)'), { code: '23505' });
      },
    } as OutboxStore;
    await expect(enqueuePush(['local'], file(1), { store: broken, config: enabled })).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith('[push] enqueue failed (23505)');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});

describe('coalescing slide (ADR 0003 §1)', () => {
  it('a single file waits 90 s', async () => {
    await register();
    await enqueuePush(['local'], file(1), { store: m.outbox, config: enabled, now: t0 });
    expect(m.rows[0]?.notBefore).toEqual(at(COALESCE_DELAY_MS));
  });

  it('each new file slides the group’s unbatched rows to now + 90 s', async () => {
    await register();
    await enqueuePush(['local'], file(1), { store: m.outbox, config: enabled, now: t0 });
    await enqueuePush(['local'], file(2), { store: m.outbox, config: enabled, now: at(60_000) });
    expect(m.rows.map((r) => r.notBefore)).toEqual([at(150_000), at(150_000)]);
  });

  it('is capped at the oldest row’s created_at + 10 min', async () => {
    await register();
    for (let i = 0; i < 10; i++)
      await enqueuePush(['local'], file(i), { store: m.outbox, config: enabled, now: at(i * 60_000) });
    for (const r of m.rows) expect(r.notBefore).toEqual(at(COALESCE_CAP_MS));
  });

  it('never moves not_before earlier', async () => {
    await register();
    await enqueuePush(['local'], file(1), { store: m.outbox, config: enabled, now: t0 });
    const first = m.rows[0];
    if (!first) throw new Error('no row');
    first.notBefore = at(3_600_000); // later than any slide target
    await enqueuePush(['local'], file(2), { store: m.outbox, config: enabled, now: at(10_000) });
    expect(first.notBefore).toEqual(at(3_600_000));
    expect(m.rows[1]?.notBefore).toEqual(at(100_000));
  });

  it('leaves frozen (batched) rows alone', async () => {
    await register();
    await enqueuePush(['local'], file(1), { store: m.outbox, config: enabled, now: t0 });
    await m.outbox.stampBatch([m.rows[0]?.id as string], 'b-1');
    await enqueuePush(['local'], file(2), { store: m.outbox, config: enabled, now: at(60_000) });
    expect(m.rows[0]?.notBefore).toEqual(at(COALESCE_DELAY_MS));
    expect(m.rows[1]?.notBefore).toEqual(at(150_000));
  });
});

describe('purge', () => {
  it('drops rows sent or dead before the cutoff and stale pending rows; keeps the rest', async () => {
    const { reg } = await register();
    const base = {
      registrationId: reg.id,
      groupKey: null,
      data: {},
      priority: 'NORMAL',
      expiresAt: at(86_400_000),
    };
    await m.outbox.insert({ ...base, type: 'x', dedupeKey: 'sent-old', sentAt: t0 }, t0);
    await m.outbox.insert({ ...base, type: 'x', dedupeKey: 'dead-old', deadAt: t0 }, t0);
    await m.outbox.insert({ ...base, type: 'x', dedupeKey: 'sent-new', sentAt: at(10 * 86_400_000) }, t0);
    await m.outbox.insert({ ...base, type: 'x', dedupeKey: 'pending' }, t0);
    expect(await m.outbox.purge(at(5 * 86_400_000))).toBe(3);
    expect(m.rows.map((r) => r.dedupeKey)).toEqual(['sent-new']);
  });
});
