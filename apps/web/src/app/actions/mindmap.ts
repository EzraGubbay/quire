'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { MindMapNode, Project } from '@/db/schema';
import { createMindMapNode, deleteMindMapNode, reparentMindMapNode, updateMindMapNode } from '@/lib/mindmap';
import { getProjectBySlug, projectBase } from '@/lib/projects';

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

/**
 * Invalidate the client router cache for this project's mind-map route so a later visit re-reads the forest. The
 * live canvas is unaffected: MindMapView holds its own state after mount and ignores new `initialNodes`, so a
 * re-render from here never disturbs an in-progress edit or drag.
 */
function revalidate(project: Project) {
  revalidatePath(`${projectBase(project)}/mindmap`);
}

export interface NodeResult {
  node?: MindMapNode;
  error?: string;
}
export interface OkResult {
  ok?: boolean;
  error?: string;
}

const optionalUuid = z.string().uuid().nullable().optional();

const createSchema = z.object({
  parentId: optionalUuid,
  label: z.string().trim().max(200).optional(),
  x: z.number().finite().nullable().optional(),
  y: z.number().finite().nullable().optional(),
});

export async function createMindMapNodeAction(
  slug: string,
  input: z.input<typeof createSchema>,
): Promise<NodeResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const project = await projectOr404(slug);
  try {
    const node = await createMindMapNode(project.id, {
      parentId: parsed.data.parentId ?? null,
      label: parsed.data.label,
      x: parsed.data.x ?? null,
      y: parsed.data.y ?? null,
    });
    revalidate(project);
    return { node };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function renameMindMapNodeAction(slug: string, id: string, label: string): Promise<NodeResult> {
  const clean = label.trim().slice(0, 200);
  if (!clean) return { error: 'A node needs a label.' };
  const project = await projectOr404(slug);
  const node = await updateMindMapNode(project.id, id, { label: clean });
  if (node) revalidate(project);
  return node ? { node } : { error: 'Node not found' };
}

const noteSchema = z.string().max(2_000_000);

export async function updateMindMapNoteAction(slug: string, id: string, note: string): Promise<OkResult> {
  const parsed = noteSchema.safeParse(note);
  if (!parsed.success) return { error: 'Note too long' };
  const project = await projectOr404(slug);
  const node = await updateMindMapNode(project.id, id, { note: parsed.data });
  if (node) revalidate(project);
  return node ? { ok: true } : { error: 'Node not found' };
}

const posSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

/** Persist a drag. Returns ok only; the client already moved the node optimistically. */
export async function moveMindMapNodeAction(
  slug: string,
  id: string,
  x: number,
  y: number,
): Promise<OkResult> {
  const parsed = posSchema.safeParse({ x, y });
  if (!parsed.success) return { error: 'Bad position' };
  const project = await projectOr404(slug);
  const node = await updateMindMapNode(project.id, id, { x: parsed.data.x, y: parsed.data.y });
  if (node) revalidate(project);
  return node ? { ok: true } : { error: 'Node not found' };
}

/** Clear a node's drag override so it snaps back to the computed auto-layout position. */
export async function resetMindMapPositionAction(slug: string, id: string): Promise<OkResult> {
  const project = await projectOr404(slug);
  const node = await updateMindMapNode(project.id, id, { x: null, y: null });
  if (node) revalidate(project);
  return node ? { ok: true } : { error: 'Node not found' };
}

export async function toggleMindMapCollapseAction(
  slug: string,
  id: string,
  collapsed: boolean,
): Promise<OkResult> {
  const project = await projectOr404(slug);
  const node = await updateMindMapNode(project.id, id, { collapsed });
  if (node) revalidate(project);
  return node ? { ok: true } : { error: 'Node not found' };
}

export async function reparentMindMapNodeAction(
  slug: string,
  id: string,
  parentId: string | null,
): Promise<NodeResult> {
  const project = await projectOr404(slug);
  try {
    const node = await reparentMindMapNode(project.id, id, parentId);
    if (node) revalidate(project);
    return node ? { node } : { error: 'Node not found' };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function deleteMindMapNodeAction(slug: string, id: string): Promise<OkResult> {
  const project = await projectOr404(slug);
  await deleteMindMapNode(project.id, id);
  revalidate(project);
  return { ok: true };
}
