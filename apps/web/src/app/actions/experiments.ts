'use server';

import { RUN_STATUSES } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  addObservation,
  createRun,
  deleteExperiment,
  deleteObservation,
  deleteRun,
  ensureExperiment,
  getRun,
  updateExperiment,
  updateRun,
} from '@/lib/experiments';
import { getProjectBySlug } from '@/lib/projects';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

const expSchema = z.object({
  slug: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
});

export async function createExperimentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = expSchema.safeParse({
    slug: formData.get('slug'),
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(parsed.data.slug);
  const exp = await ensureExperiment(project.id, parsed.data.name, parsed.data.description);
  if (parsed.data.description && !exp.description)
    await updateExperiment(project.id, exp.id, { description: parsed.data.description });
  revalidatePath(`/p/${parsed.data.slug}/experiments`);
  redirect(`/p/${parsed.data.slug}/experiments/${exp.id}`);
}

export async function deleteExperimentAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteExperiment(project.id, id);
  revalidatePath(`/p/${slug}/experiments`);
  redirect(`/p/${slug}/experiments`);
}

const runSchema = z.object({
  slug: z.string().min(1),
  experimentId: z.string().uuid(),
  name: z.string().trim().max(200).default(''),
  status: z.enum(RUN_STATUSES).default('queued'),
  params: z.string().max(20000).default(''),
});

/** Manual run creation from the UI; params are a JSON object or `key=value` lines. */
export async function createRunAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = runSchema.safeParse({
    slug: formData.get('slug'),
    experimentId: formData.get('experimentId'),
    name: formData.get('name') ?? '',
    status: formData.get('status') ?? 'queued',
    params: formData.get('params') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const params = parseParams(parsed.data.params);
  if (params === null) return { error: 'Params must be JSON or key=value lines.' };
  const project = await projectOr404(parsed.data.slug);
  const run = await createRun(parsed.data.experimentId, {
    name: parsed.data.name || undefined,
    status: parsed.data.status,
    params,
  });
  revalidatePath(`/p/${parsed.data.slug}/experiments/${parsed.data.experimentId}`);
  redirect(`/p/${parsed.data.slug}/experiments/${parsed.data.experimentId}/runs/${run.id}`);
  void project;
}

function parseParams(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const out: Record<string, unknown> = {};
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.+?)\s*$/);
    if (!m?.[1] || m[2] === undefined) return null;
    const raw = m[2];
    const num = Number(raw);
    out[m[1]] =
      raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(num) && raw !== '' ? num : raw;
  }
  return out;
}

export async function setRunStatusAction(
  slug: string,
  runId: string,
  status: (typeof RUN_STATUSES)[number],
): Promise<void> {
  const project = await projectOr404(slug);
  const found = await getRun(project.id, runId);
  if (!found) return;
  await updateRun(runId, { status });
  revalidatePath(`/p/${slug}/experiments/${found.experiment.id}/runs/${runId}`);
}

export async function updateRunNotesAction(slug: string, runId: string, notes: string): Promise<void> {
  const project = await projectOr404(slug);
  const found = await getRun(project.id, runId);
  if (!found) return;
  await updateRun(runId, { notes: notes.slice(0, 20000) });
  revalidatePath(`/p/${slug}/experiments/${found.experiment.id}/runs/${runId}`);
}

export async function deleteRunAction(slug: string, runId: string): Promise<void> {
  const project = await projectOr404(slug);
  const found = await getRun(project.id, runId);
  if (!found) return;
  await deleteRun(runId);
  revalidatePath(`/p/${slug}/experiments/${found.experiment.id}`);
  redirect(`/p/${slug}/experiments/${found.experiment.id}`);
}

export async function addObservationAction(slug: string, runId: string, body: string): Promise<void> {
  const project = await projectOr404(slug);
  const found = await getRun(project.id, runId);
  if (!found || !body.trim()) return;
  await addObservation(runId, body.trim().slice(0, 20000));
  revalidatePath(`/p/${slug}/experiments/${found.experiment.id}/runs/${runId}`);
}

export async function deleteObservationAction(slug: string, runId: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  const found = await getRun(project.id, runId);
  if (!found) return;
  await deleteObservation(id);
  revalidatePath(`/p/${slug}/experiments/${found.experiment.id}/runs/${runId}`);
}
