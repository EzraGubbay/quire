'use server';

import { SOURCE_TYPES } from '@quire/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getProjectBySlug } from '@/lib/projects';
import { createSource, deleteSource, snapshotUrl, updateSource } from '@/lib/sources';

export interface ActionState {
  error?: string;
  ok?: boolean;
}

async function projectOr404(slug: string) {
  const project = await getProjectBySlug(slug);
  if (!project) throw new Error('project not found');
  return project;
}

const tags = (s: unknown) =>
  String(s ?? '')
    .split(',')
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 20);

const schema = z.object({
  slug: z.string().min(1),
  id: z.string().uuid().optional(),
  url: z
    .string()
    .trim()
    .url()
    .or(z.literal(''))
    .transform((v) => v || null),
  title: z.string().trim().max(300),
  type: z.enum(SOURCE_TYPES),
  description: z.string().trim().max(5000).default(''),
  tags: z.array(z.string()),
  snapshot: z.boolean(),
});

/** Create or update a source. With a URL and snapshot on, fetches the page for a title and text. */
export async function saveSourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = schema.safeParse({
    slug: formData.get('slug'),
    id: formData.get('id') || undefined,
    url: formData.get('url') ?? '',
    title: formData.get('title') ?? '',
    type: formData.get('type') ?? 'web',
    description: formData.get('description') ?? '',
    tags: tags(formData.get('tags')),
    snapshot: formData.get('snapshot') === 'on',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  const { slug, id, url, snapshot } = parsed.data;
  let { title, type } = parsed.data;
  let snapshotText: string | null | undefined;
  if (url && snapshot) {
    try {
      const snap = await snapshotUrl(url);
      title = title || snap.title;
      if (type === 'web') type = snap.type;
      snapshotText = snap.text || null;
    } catch (err) {
      if (!title)
        return {
          error: `Could not fetch the page: ${(err as Error).message}. Give it a title to save anyway.`,
        };
    }
  }
  if (!title) title = url ? new URL(url).hostname : 'Untitled source';
  const project = await projectOr404(slug);
  const input = {
    url,
    title,
    type,
    description: parsed.data.description,
    tags: parsed.data.tags,
    ...(snapshotText !== undefined ? { snapshotText } : {}),
  };
  if (id) await updateSource(project.id, id, input);
  else await createSource(project.id, input);
  revalidatePath(`/p/${slug}/sources`);
  return { ok: true };
}

export async function deleteSourceAction(slug: string, id: string): Promise<void> {
  const project = await projectOr404(slug);
  await deleteSource(project.id, id);
  revalidatePath(`/p/${slug}/sources`);
}
