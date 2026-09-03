import type { RunStatus } from '@quire/shared';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  type Experiment,
  experiments,
  type Observation,
  observations,
  type Run,
  type RunArtifact,
  type RunLog,
  type RunMetric,
  runArtifacts,
  runLogs,
  runMetrics,
  runs,
} from '@/db/schema';
import { storeFile } from './files';

export interface ExperimentWithCounts extends Experiment {
  runCount: number;
  running: number;
  lastRunAt: Date | null;
}

export async function listExperiments(projectId: string): Promise<ExperimentWithCounts[]> {
  const rows = await db
    .select({
      e: experiments,
      runCount: sql<number>`count(${runs.id})::int`,
      running: sql<number>`count(${runs.id}) filter (where ${runs.status} = 'running')::int`,
      lastRunAt: sql<Date | null>`max(${runs.createdAt})`,
    })
    .from(experiments)
    .leftJoin(runs, eq(runs.experimentId, experiments.id))
    .where(eq(experiments.projectId, projectId))
    .groupBy(experiments.id)
    .orderBy(desc(sql`max(${runs.createdAt})`), desc(experiments.updatedAt));
  return rows.map((r) => ({
    ...r.e,
    runCount: r.runCount,
    running: r.running,
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
  }));
}

export async function getExperiment(projectId: string, id: string): Promise<Experiment | undefined> {
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.id, id), eq(experiments.projectId, projectId)))
    .limit(1);
  return rows[0];
}

/** Finds or creates an experiment by name; the Python client uses this so scripts need no setup step. */
export async function ensureExperiment(
  projectId: string,
  name: string,
  description = '',
): Promise<Experiment> {
  const clean = name.trim();
  const [existing] = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.projectId, projectId), eq(experiments.name, clean)))
    .limit(1);
  if (existing) return existing;
  const [row] = await db.insert(experiments).values({ projectId, name: clean, description }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateExperiment(
  projectId: string,
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  await db
    .update(experiments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(experiments.id, id), eq(experiments.projectId, projectId)));
}

export async function deleteExperiment(projectId: string, id: string): Promise<void> {
  await db.delete(experiments).where(and(eq(experiments.id, id), eq(experiments.projectId, projectId)));
}

export async function listRuns(experimentId: string): Promise<Run[]> {
  return db.select().from(runs).where(eq(runs.experimentId, experimentId)).orderBy(desc(runs.createdAt));
}

/** A run with its experiment, verified to belong to the project. */
export async function getRun(
  projectId: string,
  runId: string,
): Promise<{ run: Run; experiment: Experiment } | undefined> {
  const rows = await db
    .select({ run: runs, experiment: experiments })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .where(and(eq(runs.id, runId), eq(experiments.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export async function createRun(
  experimentId: string,
  input: { name?: string; params?: Record<string, unknown>; status?: RunStatus; notes?: string },
): Promise<Run> {
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(eq(runs.experimentId, experimentId));
  const status = input.status ?? 'running';
  const [row] = await db
    .insert(runs)
    .values({
      experimentId,
      name: input.name?.trim() || `run-${(count?.n ?? 0) + 1}`,
      params: input.params ?? {},
      status,
      notes: input.notes ?? '',
      startedAt: status === 'running' ? new Date() : null,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateRun(
  runId: string,
  patch: { name?: string; status?: RunStatus; notes?: string; params?: Record<string, unknown> },
): Promise<Run | undefined> {
  const values: Partial<Run> = { ...patch, updatedAt: new Date() } as Partial<Run>;
  if (patch.status === 'running') values.startedAt = new Date();
  if (patch.status === 'done' || patch.status === 'failed') values.finishedAt = new Date();
  const [row] = await db.update(runs).set(values).where(eq(runs.id, runId)).returning();
  return row;
}

export async function deleteRun(runId: string): Promise<void> {
  await db.delete(runs).where(eq(runs.id, runId));
}

export interface MetricPoint {
  key: string;
  value: number;
  step?: number;
  ts?: Date;
}

/** Appends metric points and refreshes the run's latest-value summary. */
export async function logMetrics(runId: string, points: MetricPoint[]): Promise<void> {
  if (points.length === 0) return;
  await db
    .insert(runMetrics)
    .values(
      points.map((p) => ({ runId, key: p.key, value: p.value, step: p.step ?? 0, ts: p.ts ?? new Date() })),
    );
  const [run] = await db.select({ summary: runs.summary }).from(runs).where(eq(runs.id, runId));
  const summary = { ...((run?.summary as Record<string, number>) ?? {}) };
  for (const p of points) summary[p.key] = p.value;
  await db.update(runs).set({ summary, updatedAt: new Date() }).where(eq(runs.id, runId));
}

export async function getMetrics(runId: string): Promise<RunMetric[]> {
  return db
    .select()
    .from(runMetrics)
    .where(eq(runMetrics.runId, runId))
    .orderBy(asc(runMetrics.key), asc(runMetrics.step), asc(runMetrics.ts));
}

export async function appendLogs(
  runId: string,
  lines: { level?: string; message: string; ts?: Date }[],
): Promise<void> {
  if (lines.length === 0) return;
  await db.insert(runLogs).values(
    lines.map((l) => ({
      runId,
      level: l.level ?? 'info',
      message: l.message.slice(0, 10000),
      ts: l.ts ?? new Date(),
    })),
  );
}

export async function getLogs(runId: string, limit = 2000): Promise<RunLog[]> {
  return db
    .select()
    .from(runLogs)
    .where(eq(runLogs.runId, runId))
    .orderBy(asc(runLogs.ts), asc(runLogs.id))
    .limit(limit);
}

export async function addArtifact(
  projectId: string,
  runId: string,
  name: string,
  contentType: string,
  data: Uint8Array,
): Promise<RunArtifact> {
  const [row] = await db
    .insert(runArtifacts)
    .values({ runId, name: name.slice(0, 200), filePath: '', size: data.byteLength, contentType })
    .returning();
  if (!row) throw new Error('insert returned no row');
  const ext = name.includes('.') ? (name.split('.').pop() ?? 'bin') : 'bin';
  const rel = await storeFile(projectId, `artifacts/${runId}/${row.id}`, ext, data);
  await db.update(runArtifacts).set({ filePath: rel }).where(eq(runArtifacts.id, row.id));
  return { ...row, filePath: rel };
}

export async function getArtifacts(runId: string): Promise<RunArtifact[]> {
  return db
    .select()
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, runId))
    .orderBy(asc(runArtifacts.createdAt));
}

export async function getArtifact(id: string): Promise<RunArtifact | undefined> {
  const rows = await db.select().from(runArtifacts).where(eq(runArtifacts.id, id)).limit(1);
  return rows[0];
}

export async function listObservations(runId: string): Promise<Observation[]> {
  return db
    .select()
    .from(observations)
    .where(eq(observations.runId, runId))
    .orderBy(asc(observations.createdAt));
}

export async function addObservation(runId: string, body: string): Promise<Observation> {
  const [row] = await db.insert(observations).values({ runId, body }).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function deleteObservation(id: string): Promise<void> {
  await db.delete(observations).where(eq(observations.id, id));
}
