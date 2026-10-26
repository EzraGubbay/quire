// Course mappings: a Quire course ↔ a Lemida (Moodle) course, with per-course sync state.
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type LemidaCourse, lemidaCourses, type Project, projects } from '@/db/schema';

/** Moodle course URLs look like …/course/view.php?id=1234 — pull the id when present. */
export function parseLemidaCourseId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('id');
  } catch {
    return null;
  }
}

export interface MappingWithProject extends LemidaCourse {
  project: Project;
}

/** Every mapping, with its Quire course, newest first. Orphan mappings (course deleted) are skipped. */
export async function listMappings(): Promise<MappingWithProject[]> {
  const rows = await db
    .select({ m: lemidaCourses, p: projects })
    .from(lemidaCourses)
    .innerJoin(projects, eq(lemidaCourses.projectId, projects.id))
    .orderBy(desc(lemidaCourses.updatedAt));
  return rows.map((r) => ({ ...r.m, project: r.p }));
}

/** Only the enabled mappings, for the agent to crawl. */
export async function enabledMappings(): Promise<MappingWithProject[]> {
  return (await listMappings()).filter((m) => m.enabled);
}

export async function getMapping(id: string): Promise<LemidaCourse | undefined> {
  const [row] = await db.select().from(lemidaCourses).where(eq(lemidaCourses.id, id)).limit(1);
  return row;
}

/** Create or update the mapping for a course (one Lemida URL per course). */
export async function mapCourse(projectId: string, lemidaUrl: string, label = ''): Promise<LemidaCourse> {
  const lemidaCourseId = parseLemidaCourseId(lemidaUrl);
  const [existing] = await db
    .select()
    .from(lemidaCourses)
    .where(and(eq(lemidaCourses.projectId, projectId), eq(lemidaCourses.lemidaUrl, lemidaUrl)))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(lemidaCourses)
      .set({ label, lemidaCourseId, updatedAt: new Date() })
      .where(eq(lemidaCourses.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [row] = await db
    .insert(lemidaCourses)
    .values({ projectId, lemidaUrl, lemidaCourseId, label })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function setMappingEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(lemidaCourses).set({ enabled, updatedAt: new Date() }).where(eq(lemidaCourses.id, id));
}

export async function deleteMapping(id: string): Promise<void> {
  await db.delete(lemidaCourses).where(eq(lemidaCourses.id, id));
}

export async function markSynced(id: string): Promise<void> {
  await db
    .update(lemidaCourses)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(lemidaCourses.id, id));
}
