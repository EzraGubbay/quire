// The command/status channel between the Quire panel (enqueues) and the Mac agent (claims + completes).
import type { LemidaCommandKind } from '@quire/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type LemidaCommand, lemidaCommands } from '@/db/schema';

/**
 * Enqueue a command for the agent. Coalesces: if one of the same kind is already waiting (or running),
 * reuse it rather than piling up — the panel's buttons are idempotent.
 */
export async function enqueueCommand(
  kind: LemidaCommandKind,
  payload: Record<string, unknown> = {},
): Promise<LemidaCommand> {
  const [existing] = await db
    .select()
    .from(lemidaCommands)
    .where(and(eq(lemidaCommands.kind, kind), eq(lemidaCommands.status, 'pending')))
    .limit(1);
  if (existing) {
    if (Object.keys(payload).length === 0) return existing;
    const [updated] = await db
      .update(lemidaCommands)
      .set({ payload, updatedAt: new Date() })
      .where(eq(lemidaCommands.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [row] = await db.insert(lemidaCommands).values({ kind, payload }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Atomically take the oldest pending command and mark it running. */
export async function claimNextCommand(): Promise<LemidaCommand | undefined> {
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
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(lemidaCommands.id, row.id))
      .returning();
    return updated;
  });
}

export async function completeCommand(
  id: string,
  status: 'done' | 'error',
  result: Record<string, unknown> = {},
): Promise<void> {
  await db
    .update(lemidaCommands)
    .set({ status, result, updatedAt: new Date() })
    .where(eq(lemidaCommands.id, id));
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
