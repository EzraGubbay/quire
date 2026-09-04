import { z } from 'zod';
import { apiError, json } from '@/lib/api';
import { listClientLogs, storeClientLogs } from '@/lib/debug';

export const dynamic = 'force-dynamic';

const schema = z.object({
  session: z.string().min(1).max(80),
  platform: z.string().max(20).optional(),
  entries: z
    .array(
      z.object({
        ts: z.string(),
        level: z.string().max(10),
        source: z.string().max(40),
        message: z.string().max(4000),
        data: z.unknown().optional(),
        url: z.string().max(1000).optional(),
      }),
    )
    .max(500),
});

/** Receives client debug batches (sendBeacon or fetch). */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError('Invalid log batch');
  const stored = await storeClientLogs({
    ...parsed.data,
    userAgent: req.headers.get('user-agent') ?? undefined,
  });
  return json({ ok: true, stored });
}

/** GET ?session=&level=&limit= for reading logs with a bearer key or session. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const rows = await listClientLogs({
    session: u.searchParams.get('session') ?? undefined,
    level: u.searchParams.get('level') ?? undefined,
    limit: Number(u.searchParams.get('limit') ?? 300),
    sinceHours: Number(u.searchParams.get('hours') ?? 0) || undefined,
  });
  return json(rows);
}
