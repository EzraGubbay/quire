import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { convertHealth } from '@/lib/convert';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const gotenberg = await convertHealth();
    return Response.json({ ok: true, db: 'up', gotenberg, version: process.env.QUIRE_VERSION ?? 'dev' });
  } catch (err) {
    return Response.json({ ok: false, db: 'down', error: (err as Error).message }, { status: 503 });
  }
}
