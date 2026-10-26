// The agent posts its session-probe result and sync summary here; also a heartbeat.
import { z } from 'zod';
import { json, readJson } from '@/lib/api';
import { type LemidaState, saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

const schema = z.object({
  sessionStatus: z.enum(['unknown', 'valid', 'expired']).optional(),
  lastSyncSummary: z.string().max(500).optional(),
  lastSyncAt: z.string().optional(),
});

export async function POST(req: Request) {
  const body = await readJson(req, schema);
  if (!body.ok) return body.res;
  const now = new Date().toISOString();
  const patch: Partial<LemidaState> = { agentSeenAt: now };
  if (body.data.sessionStatus) {
    patch.sessionStatus = body.data.sessionStatus;
    patch.checkedAt = now;
  }
  if (body.data.lastSyncSummary !== undefined) patch.lastSyncSummary = body.data.lastSyncSummary;
  if (body.data.lastSyncAt !== undefined) patch.lastSyncAt = body.data.lastSyncAt;
  await saveLemidaState(patch);
  return json({ ok: true });
}
