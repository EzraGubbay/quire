'use server';

import { getProjectBySlug, projectBase } from '@/lib/projects';
import { requireSession } from '@/lib/require-session';
import { type SearchHit, searchProject } from '@/lib/search';

export async function searchAction(slug: string, query: string): Promise<SearchHit[]> {
  await requireSession();
  const project = await getProjectBySlug(slug);
  if (!project) return [];
  return searchProject(project.id, projectBase(project), query);
}
