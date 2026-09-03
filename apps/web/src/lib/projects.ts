import { type ProjectCreate, slugify } from '@quire/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Project, projects } from '@/db/schema';

export async function listProjects(status: 'active' | 'archived' = 'active'): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.status, status)).orderBy(desc(projects.updatedAt));
}

export async function getProjectBySlug(slug: string): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0];
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
    .values({ name: input.name, description: input.description, slug })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function setProjectStatus(id: string, status: 'active' | 'archived'): Promise<void> {
  await db
    .update(projects)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(projects.id, id)));
}
