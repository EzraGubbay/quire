// The command/status channel between the Quire panel (enqueues) and the Mac agent (claims + completes).
import type { LemidaCommandKind } from '@quire/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type LemidaCommand, lemidaCommands } from '@/db/schema';
import { enabledMappings } from './courses';

/** New engine: heartbeats every 30 s, so 4 missed beats. */
export const LEASE_MS = 2 * 60_000;
/** Rows claimed without ?lease=1 (installed app, CLI agent) never heartbeat; give them a long lease. */
export const LEGACY_LEASE_MS = 30 * 60_000;
/** A command nobody picked up in this long is stale. Equals AGENT_STALE_MS, so offline ⇔ expiring. */
export const PENDING_TTL_MS = 10 * 60_000;
export const LEASE_EXPIRED_MESSAGE =
  'The desktop app stopped responding while this was running (quit, crashed or asleep).';
export const EXPIRED_MESSAGE =
  'Not picked up within 10 minutes: the desktop app was not running. Try again once it is open.';

/**
 * Fail commands nobody is working on any more: running rows whose lease lapsed, then (only when nothing is
 * running, so a probe queued behind a live sync survives) pending rows older than PENDING_TTL_MS.
 */
export async function reapStaleCommands(
  now = new Date(),
): Promise<{ leaseExpired: string[]; expired: string[] }> {
  const leaseCutoff = new Date(now.getTime() - LEASE_MS);
  const legacyCutoff = new Date(now.getTime() - LEGACY_LEASE_MS);
  const pendingCutoff = new Date(now.getTime() - PENDING_TTL_MS);
  return db.transaction(async (tx) => {
    const lost = await tx
      .update(lemidaCommands)
      .set({
        status: 'error',
        result: { reason: 'lease_expired', message: LEASE_EXPIRED_MESSAGE },
        updatedAt: now,
      })
      .where(
        and(
          eq(lemidaCommands.status, 'running'),
          or(
            and(isNotNull(lemidaCommands.heartbeatAt), lt(lemidaCommands.heartbeatAt, leaseCutoff)),
            and(isNull(lemidaCommands.heartbeatAt), lt(lemidaCommands.updatedAt, legacyCutoff)),
          ),
        ),
      )
      .returning({ id: lemidaCommands.id });
    const [stillRunning] = await tx
      .select({ id: lemidaCommands.id })
      .from(lemidaCommands)
      .where(eq(lemidaCommands.status, 'running'))
      .limit(1);
    let expired: { id: string }[] = [];
    if (!stillRunning) {
      expired = await tx
        .update(lemidaCommands)
        .set({
          status: 'error',
          result: { reason: 'expired', message: EXPIRED_MESSAGE },
          updatedAt: now,
        })
        .where(and(eq(lemidaCommands.status, 'pending'), lt(lemidaCommands.updatedAt, pendingCutoff)))
        .returning({ id: lemidaCommands.id });
    }
    return { leaseExpired: lost.map((r) => r.id), expired: expired.map((r) => r.id) };
  });
}

/**
 * Enqueue a command for the agent. Coalesces: if one of the same kind is already waiting (or running),
 * reuse it rather than piling up — the panel's buttons are idempotent.
 */
export async function enqueueCommand(
  kind: LemidaCommandKind,
  payload: Record<string, unknown> = {},
  now = new Date(),
): Promise<LemidaCommand> {
  await reapStaleCommands(now);
  const [existing] = await db
    .select()
    .from(lemidaCommands)
    .where(and(eq(lemidaCommands.kind, kind), eq(lemidaCommands.status, 'pending')))
    .limit(1);
  if (existing) {
    // Always bump updatedAt: a reused row must not expire 10 min after its *first* click.
    const [updated] = await db
      .update(lemidaCommands)
      .set(Object.keys(payload).length === 0 ? { updatedAt: now } : { payload, updatedAt: now })
      .where(eq(lemidaCommands.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [row] = await db.insert(lemidaCommands).values({ kind, payload }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/**
 * Enqueue for the engine's auto-sync: never touches an existing pending/running row of the same kind (so it
 * cannot overwrite a manual or full-rescan payload), and a sync is only queued when a mapping is enabled.
 */
export async function enqueueIfIdle(
  kind: LemidaCommandKind,
  payload: Record<string, unknown> = {},
  now = new Date(),
): Promise<{ command: LemidaCommand | null; created: boolean; reason?: 'busy' | 'no-mappings' }> {
  await reapStaleCommands(now);
  const [busy] = await db
    .select()
    .from(lemidaCommands)
    .where(and(eq(lemidaCommands.kind, kind), inArray(lemidaCommands.status, ['pending', 'running'])))
    .limit(1);
  if (busy) return { command: busy, created: false, reason: 'busy' };
  if (kind === 'sync' && (await enabledMappings()).length === 0) {
    return { command: null, created: false, reason: 'no-mappings' };
  }
  const [row] = await db
    .insert(lemidaCommands)
    .values({ kind, payload, createdAt: now, updatedAt: now })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { command: row, created: true };
}

/**
 * Atomically take the oldest pending command and mark it running. `leased` means the caller will heartbeat;
 * updatedAt stays the claim time while running (heartbeats only touch heartbeatAt).
 */
export async function claimNextCommand(
  opts: { leased?: boolean } = {},
  now = new Date(),
): Promise<LemidaCommand | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(lemidaCommands)
      .where(eq(lemidaCommands.status, 'pending'))
      .orderBy(asc(lemidaCommands.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return undefined;
    const [updated] = await tx
      .update(lemidaCommands)
      .set({ status: 'running', updatedAt: now, heartbeatAt: opts.leased ? now : null })
      .where(eq(lemidaCommands.id, row.id))
      .returning();
    return updated;
  });
}

/** Lease proof of life. False when the row is no longer running (the engine should stop beating). */
export async function heartbeatCommand(id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(lemidaCommands)
    .set({ heartbeatAt: now })
    .where(and(eq(lemidaCommands.id, id), eq(lemidaCommands.status, 'running')))
    .returning({ id: lemidaCommands.id });
  return rows.length > 0;
}

/**
 * Record an outcome. Applies to a running row, or to a lease_expired guess (a late completion wins, e.g. the Mac
 * slept through a sync then finished). Never resurrects an expired pending row, watchdog timeout or finished row.
 */
export async function completeCommand(
  id: string,
  status: 'done' | 'error',
  result: Record<string, unknown> = {},
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(lemidaCommands)
    .set({ status, result, updatedAt: now })
    .where(
      and(
        eq(lemidaCommands.id, id),
        or(
          eq(lemidaCommands.status, 'running'),
          and(eq(lemidaCommands.status, 'error'), sql`${lemidaCommands.result}->>'reason' = 'lease_expired'`),
        ),
      ),
    )
    .returning({ id: lemidaCommands.id });
  return rows.length > 0;
}

/** For the panel: what is happening now (running, else oldest pending) and the last finished command. */
export async function commandOverview(): Promise<{
  current: LemidaCommand | null;
  last: LemidaCommand | null;
}> {
  const [running] = await db
    .select()
    .from(lemidaCommands)
    .where(eq(lemidaCommands.status, 'running'))
    .orderBy(desc(lemidaCommands.updatedAt))
    .limit(1);
  const [pending] = running
    ? []
    : await db
        .select()
        .from(lemidaCommands)
        .where(eq(lemidaCommands.status, 'pending'))
        .orderBy(asc(lemidaCommands.createdAt))
        .limit(1);
  const [last] = await db
    .select()
    .from(lemidaCommands)
    .where(inArray(lemidaCommands.status, ['done', 'error']))
    .orderBy(desc(lemidaCommands.updatedAt))
    .limit(1);
  return { current: running ?? pending ?? null, last: last ?? null };
}

/** Is any command still pending or running? The panel polls while so. */
export async function hasActiveCommand(): Promise<boolean> {
  const [row] = await db
    .select({ id: lemidaCommands.id })
    .from(lemidaCommands)
    .where(eq(lemidaCommands.status, 'pending'))
    .limit(1);
  if (row) return true;
  const [running] = await db
    .select({ id: lemidaCommands.id })
    .from(lemidaCommands)
    .where(eq(lemidaCommands.status, 'running'))
    .limit(1);
  return Boolean(running);
}

export async function recentCommands(limit = 10): Promise<LemidaCommand[]> {
  return db.select().from(lemidaCommands).orderBy(desc(lemidaCommands.createdAt)).limit(limit);
}
