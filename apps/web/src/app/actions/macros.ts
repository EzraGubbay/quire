'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { deleteMacro, parseMacroLine, upsertMacro } from '@/lib/macros';
import { getProjectBySlug } from '@/lib/projects';

export interface ActionState {
  error?: string;
  ok?: boolean;
  added?: number;
}

const schema = z.object({ slug: z.string().optional(), text: z.string().max(20000) });

/** Adds or updates macros from a textarea: one per line, `\newcommand{\name}[n]{def}` or `\name[n]: def`. */
export async function addMacrosAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = schema.safeParse({
    slug: formData.get('slug') ?? undefined,
    text: formData.get('text') ?? '',
  });
  if (!parsed.success) return { error: 'Invalid input' };
  let projectId: string | null = null;
  if (parsed.data.slug) {
    const project = await getProjectBySlug(parsed.data.slug);
    if (!project) return { error: 'Project not found' };
    projectId = project.id;
  }
  const lines = parsed.data.text.split('\n');
  const bad: string[] = [];
  let added = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = parseMacroLine(line);
    if (!m) {
      bad.push(line.trim());
      continue;
    }
    await upsertMacro(projectId, m.name, m.definition, m.arity);
    added++;
  }
  revalidatePath('/settings');
  if (parsed.data.slug) revalidatePath(`/p/${parsed.data.slug}`, 'layout');
  if (bad.length) return { error: `Could not parse: ${bad.slice(0, 3).join(' · ')}`, added };
  return { ok: true, added };
}

export async function deleteMacroAction(id: string, slug?: string): Promise<void> {
  await deleteMacro(id);
  revalidatePath('/settings');
  if (slug) revalidatePath(`/p/${slug}`, 'layout');
}
