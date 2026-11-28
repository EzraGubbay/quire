// Operator pause flag for the jobs worker: `settings.data.jobs.paused`. While set, the worker claims nothing
// new; a job already running continues. Read-modify-write on settings row 1, like the other settings flags.
import { eq } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { JobsExecutor } from './queue';

type JobsSettings = { jobs?: { paused?: unknown } & Record<string, unknown> } & Record<string, unknown>;

async function readData(db: JobsExecutor): Promise<{ exists: boolean; data: JobsSettings }> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  return { exists: Boolean(row), data: (row?.data as JobsSettings | undefined) ?? {} };
}

export async function jobsPaused(db: JobsExecutor): Promise<boolean> {
  return Boolean((await readData(db)).data.jobs?.paused);
}

export async function setJobsPaused(db: JobsExecutor, paused: boolean): Promise<void> {
  const { exists, data: current } = await readData(db);
  const data = { ...current, jobs: { ...current.jobs, paused } };
  if (exists) await db.update(settings).set({ data, updatedAt: new Date() }).where(eq(settings.id, 1));
  else await db.insert(settings).values({ id: 1, data });
}
