import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: 'up', version: process.env.QUIRE_VERSION ?? 'dev' });
  } catch (err) {
    return Response.json({ ok: false, db: 'down', error: (err as Error).message }, { status: 503 });
  }
}
