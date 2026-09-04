import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type ClientLog, clientLogs, settings } from '@/db/schema';

export async function getDebugSetting(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  return Boolean((row?.data as { debug?: unknown } | undefined)?.debug);
}

export async function saveDebugSetting(on: boolean): Promise<void> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const data = { ...((row?.data as Record<string, unknown>) ?? {}), debug: on };
  if (row) await db.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  else await db.insert(settings).values({ id: 1, data });
}

export interface IncomingEntry {
  ts: string;
  level: string;
  source: string;
  message: string;
  data?: unknown;
  url?: string;
}

export async function storeClientLogs(input: {
  session: string;
  platform?: string;
  userAgent?: string;
  entries: IncomingEntry[];
}): Promise<number> {
  if (input.entries.length === 0) return 0;
  await db.insert(clientLogs).values(
    input.entries.slice(0, 500).map((e) => ({
      session: input.session.slice(0, 80),
      level: ['debug', 'info', 'warn', 'error'].includes(e.level) ? e.level : 'info',
      source: e.source.slice(0, 40),
      message: e.message.slice(0, 4000),
      data: e.data ?? null,
      url: e.url?.slice(0, 1000) ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      platform: input.platform ?? null,
      clientTs: Number.isNaN(Date.parse(e.ts)) ? new Date() : new Date(e.ts),
    })),
  );
  // Keep the table bounded.
  await db.delete(clientLogs).where(lt(clientLogs.createdAt, new Date(Date.now() - 14 * 24 * 3600 * 1000)));
  return input.entries.length;
}

export async function listClientLogs(
  opts: { limit?: number; session?: string; level?: string; sinceHours?: number } = {},
): Promise<ClientLog[]> {
  const conds = [];
  if (opts.session) conds.push(eq(clientLogs.session, opts.session));
  if (opts.level) conds.push(eq(clientLogs.level, opts.level));
  if (opts.sinceHours)
    conds.push(gte(clientLogs.createdAt, new Date(Date.now() - opts.sinceHours * 3600 * 1000)));
  return db
    .select()
    .from(clientLogs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(clientLogs.clientTs))
    .limit(Math.min(2000, opts.limit ?? 300));
}

export interface SessionSummary {
  session: string;
  platform: string | null;
  userAgent: string | null;
  first: Date;
  last: Date;
  entries: number;
  errors: number;
  crash: boolean;
}

export async function listSessions(limit = 30): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      session: clientLogs.session,
      platform: sql<string | null>`max(${clientLogs.platform})`,
      userAgent: sql<string | null>`max(${clientLogs.userAgent})`,
      first: sql<Date>`min(${clientLogs.clientTs})`,
      last: sql<Date>`max(${clientLogs.clientTs})`,
      entries: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${clientLogs.level} = 'error')::int`,
      crash: sql<boolean>`bool_or(${clientLogs.source} = 'crash')`,
    })
    .from(clientLogs)
    .groupBy(clientLogs.session)
    .orderBy(sql`max(${clientLogs.clientTs}) desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, first: new Date(r.first), last: new Date(r.last) }));
}

export async function clearClientLogs(): Promise<void> {
  await db.delete(clientLogs);
}
