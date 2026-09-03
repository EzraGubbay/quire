'use server';

import { getProjectBySlug } from '@/lib/projects';
import { type SearchHit, searchProject } from '@/lib/search';

export async function searchAction(slug: string, query: string): Promise<SearchHit[]> {
  const project = await getProjectBySlug(slug);
  if (!project) return [];
  return searchProject(project.id, slug, query);
}
