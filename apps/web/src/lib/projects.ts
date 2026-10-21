import {
  type CourseCreate,
  type ProjectCreate,
  type ProjectKind,
  type ProjectMeta,
  type ProjectStatus,
  projectMetaSchema,
  slugify,
} from '@quire/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { folders, type Project, projects } from '@/db/schema';
import { baseFor } from '@/lib/side';

export interface ListProjectsOptions {
  kind?: ProjectKind;
  status?: ProjectStatus | 'all';
}

export async function listProjects(opts: ListProjectsOptions = {}): Promise<Project[]> {
  const { kind, status = 'active' } = opts;
  const where = [
    kind ? eq(projects.kind, kind) : undefined,
    status === 'all' ? undefined : eq(projects.status, status),
  ]
    .filter(Boolean)
    .map((w) => w as NonNullable<typeof w>);
  return db
    .select()
    .from(projects)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(projects.updatedAt));
}

export async function getProjectBySlug(slug: string): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0];
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

/** URL prefix for a workspace: research projects live under /p, courses under /c. */
export const projectBase = (p: Pick<Project, 'slug' | 'kind'>): string => baseFor(p.kind, p.slug);

/** The [side] segment a kind is served under. */
export const sideFor = (kind: ProjectKind): 'p' | 'c' => (kind === 'course' ? 'c' : 'p');

/** Home page for a kind. */
export const homeFor = (kind: ProjectKind): string => (kind === 'course' ? '/courses' : '/research');

/** Pages that exist for one kind only (experiments for research, lectures for courses) call this. */
export function requireKind(project: Project, kind: ProjectKind): void {
  if (project.kind !== kind) notFound();
}

/** Course details with defaults applied; research projects get the defaults too, harmlessly. */
export function projectMeta(p: Pick<Project, 'meta'>): ProjectMeta {
  const parsed = projectMetaSchema.safeParse(p.meta ?? {});
  return parsed.success ? parsed.data : projectMetaSchema.parse({});
}

/** Picks the first free slug among name, name-2, name-3, ... */
async function freeSlug(base: string): Promise<string> {
  const like = `${base}%`;
  const taken = new Set(
    (await db.select({ slug: projects.slug }).from(projects).where(sql`${projects.slug} like ${like}`)).map(
      (r) => r.slug,
    ),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createProject(input: ProjectCreate): Promise<Project> {
  const slug = await freeSlug(slugify(input.name));
  const [row] = await db
    .insert(projects)
    .values({ name: input.name, description: input.description, slug, kind: 'research' })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

/** Every course starts with Raw and Synthesized note folders and a Practice Exams document folder. */
export async function createBuiltinFolders(projectId: string): Promise<void> {
  await db
    .insert(folders)
    .values([
      { projectId, name: 'Raw', scope: 'notes', builtin: 'raw', position: 0 },
      { projectId, name: 'Synthesized', scope: 'notes', builtin: 'synthesized', position: 1 },
      { projectId, name: 'Practice Exams', scope: 'documents', builtin: 'practice_exams', position: 0 },
    ])
    .onConflictDoNothing();
}

export async function createCourse(input: CourseCreate): Promise<Project> {
  const slug = await freeSlug(slugify(input.name));
  const meta: ProjectMeta = {
    type: input.type,
    code: input.code,
    semester: input.semester,
    links: input.links,
  };
  const [row] = await db
    .insert(projects)
    .values({ name: input.name, description: input.description, slug, kind: 'course', meta })
    .returning();
  if (!row) throw new Error('insert returned no row');
  await createBuiltinFolders(row.id);
  return row;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description'>> & { meta?: Partial<ProjectMeta> },
): Promise<void> {
  const current = await getProjectById(id);
  if (!current) return;
  const meta = patch.meta ? { ...projectMeta(current), ...patch.meta } : undefined;
  await db
    .update(projects)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(meta ? { meta } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id));
}

/** Base path for a slug; falls back to /p when the project is unknown (link still fails gracefully). */
export async function baseFromSlug(slug: string): Promise<string> {
  const p = await getProjectBySlug(slug);
  return p ? projectBase(p) : `/p/`;
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await db.update(projects).set({ status, updatedAt: new Date() }).where(eq(projects.id, id));
}
