// Project resolution for every transport. A reference is a slug or a UUID, and a project resolves only when its
// kind matches the caller's scope: the other kind answers exactly like a missing reference, so a course caller
// can neither read nor confirm a research project, and vice versa. The lookups are injected so core stays free
// of lib/projects (which imports next/navigation).
import type { ProjectKind } from '@quire/shared';
import type { Project } from '@/db/schema';

export interface ProjectLookup {
  byId(id: string): Promise<Project | undefined>;
  bySlug(slug: string): Promise<Project | undefined>;
}

// Any case: Postgres accepts upper-case UUID input. Anything else is looked up as a slug, so a malformed id
// never reaches the uuid column (which would raise invalid_text_representation).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a slug or UUID to a project of `kind`, or undefined (unknown, or the other kind). */
export async function resolveProject(
  lookup: ProjectLookup,
  kind: ProjectKind,
  ref: string,
): Promise<Project | undefined> {
  const project = UUID_RE.test(ref) ? await lookup.byId(ref) : await lookup.bySlug(ref);
  return project?.kind === kind ? project : undefined;
}
