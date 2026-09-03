import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Project, projects } from '@/db/schema';

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.status, 'active')).orderBy(desc(projects.updatedAt));
}
