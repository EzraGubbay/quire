// Push dispatcher (ADR 0003 §1, §3.3–§3.4). `dispatchDue` freezes due rows into batches (stamping `batch_id` on
// exactly the selected ids), sends one message per batch with `eventId = batch_id`, and records the outcome by batch
// id. Retries resend the same frozen batch, loaded by `batch_id`. `sendTestPush` is the synchronous POST /push/test.
// Logs carry ids and error codes only.
import { randomUUID } from 'node:crypto';
import { type PushEvent, pushTest, wireData } from './events';
import { type DueRow, errTag, type OutboxStore } from './outbox';
import type { PushMessage, PushTransport, SendResult } from './transport';

export const DISPATCH_LIMIT = 100;
export const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

/** Delay before retry number `attempts` (1-based): max(Retry-After, min(30 s · 2^(attempts−1), 30 min)). */
export function backoffMs(attempts: number, retryAfterMs?: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  return Math.max(retryAfterMs ?? 0, exp);
}

const g = globalThis as unknown as {
  __quirePushDispatching?: boolean;
  __quirePushConfigLogged?: Set<string>;
};

/** `[push] FCM config error: <code>` at most once per process per code. */
function logConfigOnce(code: string) {
  g.__quirePushConfigLogged ??= new Set();
  if (g.__quirePushConfigLogged.has(code)) return;
  g.__quirePushConfigLogged.add(code);
  console.error(`[push] FCM config error: ${code}`);
}

export interface DispatchDeps {
  store: OutboxStore;
  transport: PushTransport;
  /** Time for each batch's send and bookkeeping (fresh per batch); defaults to the wall clock. */
  clock?: () => Date;
}

/** Failures of the transport itself, not of one device: the rest of the pass would fail the same way. */
const TRANSPORT_DOWN = new Set([
  'NETWORK',
  'TIMEOUT',
  'OAUTH_UNAVAILABLE',
  'OAUTH_REJECTED',
  'BAD_PRIVATE_KEY',
]);

export interface DispatchSummary {
  batches: number;
  sent: number;
  retried: number;
  dead: number;
  pruned: number;
  expired: number;
  held: number;
  /** The pass stopped early after a network/OAuth failure; the remaining batches wait for the next pass. */
  aborted: boolean;
}

const collapseKeyFor = (type: string) => (type === 'push.test' ? 'push.test' : undefined);

/** A transport that throws (it should not) counts as a retryable network failure. */
async function safeSend(transport: PushTransport, m: PushMessage): Promise<SendResult> {
  try {
    return await transport.send(m);
  } catch {
    return { ok: false, kind: 'retryable', errorCode: 'NETWORK' };
  }
}

/** One dispatcher pass. Returns null when another pass is still running (re-entrancy guard). */
export async function dispatchDue(now: Date, deps: DispatchDeps): Promise<DispatchSummary | null> {
  if (g.__quirePushDispatching) return null;
  g.__quirePushDispatching = true;
  try {
    return await dispatchOnce(now, deps);
  } finally {
    g.__quirePushDispatching = false;
  }
}

async function dispatchOnce(now: Date, deps: DispatchDeps): Promise<DispatchSummary> {
  const { store, transport } = deps;
  const clock = deps.clock ?? (() => new Date());
  const s: DispatchSummary = {
    batches: 0,
    sent: 0,
    retried: 0,
    dead: 0,
    pruned: 0,
    expired: 0,
    held: 0,
    aborted: false,
  };
  const due = await store.due(now, DISPATCH_LIMIT);

  const expired = due.filter((r) => r.expiresAt <= now);
  await store.markRowsDead(
    expired.map((r) => r.id),
    now,
    'expired',
  );
  s.expired += expired.length;
  const live = due.filter((r) => r.expiresAt > now);

  // Frozen batches whose retry is due, then new batches from unbatched rows.
  const batchIds = [...new Set(live.flatMap((r) => (r.batchId ? [r.batchId] : [])))];
  const groups = new Map<string, DueRow[]>();
  for (const r of live) {
    if (r.batchId) continue;
    const key = r.groupKey ? `${r.registrationId}\u0000${r.groupKey}` : `row\u0000${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const first = rows[0] as DueRow;
    // An older batch of this (registration, group) awaiting retry goes first; newer rows wait for it.
    if (first.groupKey && (await store.hasPendingBatch(first.registrationId, first.groupKey))) {
      s.held += rows.length;
      continue;
    }
    const batchId = randomUUID();
    const stamped = await store.stampBatch(
      rows.map((r) => r.id),
      batchId,
    );
    if (stamped.length) batchIds.push(batchId);
  }

  for (const batchId of batchIds) {
    const result = await sendBatch(batchId, clock(), store, transport, s);
    if (result && !result.ok && TRANSPORT_DOWN.has(result.errorCode)) {
      s.aborted = true;
      break;
    }
  }
  return s;
}

async function sendBatch(
  batchId: string,
  now: Date,
  store: OutboxStore,
  transport: PushTransport,
  s: DispatchSummary,
): Promise<SendResult | null> {
  const rows = await store.batchRows(batchId);
  const expired = rows.filter((r) => r.expiresAt <= now);
  await store.markRowsDead(
    expired.map((r) => r.id),
    now,
    'expired',
  );
  s.expired += expired.length;
  const live = rows.filter((r) => r.expiresAt > now);
  if (live.length === 0) return null;
  s.batches++;

  const newest = live.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const soonest = Math.min(...live.map((r) => r.expiresAt.getTime()));
  const attempts = Math.max(...live.map((r) => r.attempts));
  const registrationId = newest.registrationId;
  const result = await safeSend(transport, {
    token: newest.fcmToken,
    data: wireData(newest.data, { eventId: batchId, count: live.length }),
    priority: newest.priority === 'HIGH' ? 'HIGH' : 'NORMAL',
    ttlSeconds: Math.floor((soonest - now.getTime()) / 1000),
    collapseKey: collapseKeyFor(newest.type),
    registrationId,
  });
  await applyOutcome(result, { batchId, registrationId, attempts, now, store, s });
  return result;
}

async function applyOutcome(
  result: SendResult,
  c: {
    batchId: string;
    registrationId: string;
    attempts: number;
    now: Date;
    store: OutboxStore;
    s: DispatchSummary;
  },
) {
  const { batchId, registrationId, now, store, s } = c;
  if (result.ok) {
    await store.markSent(batchId, now);
    await store.registrationSent(registrationId, now);
    s.sent++;
    return;
  }
  switch (result.kind) {
    case 'unregistered':
      await store.deleteRegistration(registrationId);
      console.log(`[push] pruned registration ${registrationId}`);
      s.pruned++;
      return;
    case 'config':
      // The server's credential/project is wrong, not the device: the registration stays clean.
      await store.markBatchDead(batchId, now, result.errorCode);
      logConfigOnce(result.errorCode);
      s.dead++;
      return;
    case 'retryable': {
      const attempts = c.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await store.markBatchDead(batchId, now, result.errorCode);
        s.dead++;
        return;
      }
      const at = new Date(now.getTime() + backoffMs(attempts, result.retryAfterMs));
      await store.retryBatch(batchId, attempts, at);
      s.retried++;
      return;
    }
    default:
      await store.markBatchDead(batchId, now, result.errorCode);
      await store.registrationError(registrationId, result.errorCode);
      console.warn(`[push] batch ${batchId} failed: ${result.errorCode}`);
      s.dead++;
  }
}

export type TestOutcome = 'sent' | 'unregistered' | 'retryable' | 'failed';

/**
 * POST /push/test: send `push.test` to one registration now, bypassing categories and coalescing. The send is
 * recorded in the outbox as a single-row batch that is terminal from the moment it is written (sent_at or dead_at
 * set), so the dispatcher can never resend it. Nothing is queued on failure.
 */
export async function sendTestPush(
  reg: { id: string; fcmToken: string },
  deps: DispatchDeps & { now?: Date; eventId?: string },
): Promise<{ eventId: string; outcome: TestOutcome }> {
  const now = deps.now ?? new Date();
  const eventId = deps.eventId ?? randomUUID();
  const event: PushEvent = pushTest({ eventId });
  const result = await safeSend(deps.transport, {
    token: reg.fcmToken,
    data: wireData(event.data, { eventId, count: 1 }),
    priority: event.priority,
    ttlSeconds: event.ttlSeconds,
    collapseKey: event.collapseKey,
    registrationId: reg.id,
  });

  if (!result.ok && result.kind === 'unregistered') {
    await deps.store.deleteRegistration(reg.id);
    console.log(`[push] pruned registration ${reg.id}`);
    return { eventId, outcome: 'unregistered' };
  }
  if (!result.ok && result.kind === 'config') logConfigOnce(result.errorCode);
  try {
    await deps.store.insert(
      {
        registrationId: reg.id,
        type: event.type,
        dedupeKey: event.dedupeKey,
        groupKey: null,
        batchId: eventId,
        data: event.data,
        priority: event.priority,
        expiresAt: new Date(now.getTime() + event.ttlSeconds * 1000),
        notBefore: now,
        attempts: 1,
        ...(result.ok ? { sentAt: now } : { deadAt: now, lastError: result.errorCode }),
      },
      now,
    );
    if (result.ok) await deps.store.registrationSent(reg.id, now);
  } catch (e) {
    // The push already went out (or failed); a bookkeeping error must not change the reported outcome.
    console.warn(`[push] could not record test push ${eventId} (${errTag(e)})`);
  }
  if (result.ok) return { eventId, outcome: 'sent' };
  return { eventId, outcome: result.kind === 'retryable' ? 'retryable' : 'failed' };
}
