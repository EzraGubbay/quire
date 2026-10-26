// Lemida agent heartbeat and session status, kept in the single settings row under the `lemida` key
// (same pattern as AI settings). The Mac agent writes it; the Quire panel reads it.
import type { LemidaSessionStatus } from '@quire/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { settings } from '@/db/schema';

export const lemidaStateSchema = z.object({
  /** Whether the reused browser session is still logged in, per the agent's last probe. */
  sessionStatus: z.enum(['unknown', 'valid', 'expired']).default('unknown'),
  /** When the agent last probed the session. */
  checkedAt: z.string().nullable().default(null),
  /** When the agent last contacted Quire at all (heartbeat); staleness ⇒ agent offline. */
  agentSeenAt: z.string().nullable().default(null),
  /** When the last sync finished. */
  lastSyncAt: z.string().nullable().default(null),
  /** One-line summary of the last sync, e.g. "3 imported, 1 to review". */
  lastSyncSummary: z.string().default(''),
});
export type LemidaState = z.infer<typeof lemidaStateSchema>;

/** Heartbeat older than this means the agent is considered offline. */
export const AGENT_STALE_MS = 10 * 60 * 1000;

export async function getLemidaState(): Promise<LemidaState> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = (row?.data as { lemida?: unknown } | undefined)?.lemida ?? {};
  const parsed = lemidaStateSchema.safeParse(data);
  return parsed.success ? parsed.data : lemidaStateSchema.parse({});
}

export async function saveLemidaState(patch: Partial<LemidaState>): Promise<LemidaState> {
  const current = await getLemidaState();
  const next = lemidaStateSchema.parse({ ...current, ...patch });
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = { ...((row?.data as Record<string, unknown>) ?? {}), lemida: next };
  if (row) await db.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  else await db.insert(settings).values({ id: 1, data });
  return next;
}

/** The agent is online when its heartbeat is recent. */
export function agentOnline(state: Pick<LemidaState, 'agentSeenAt'>): boolean {
  if (!state.agentSeenAt) return false;
  const seen = Date.parse(state.agentSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < AGENT_STALE_MS;
}

export type { LemidaSessionStatus };
