// Who may hear about a course (ADR 0003 §3.3). Projects have no owner column yet, so an active course reaches every
// owner with an active registration; this is the single seam to change when courses gain owners.
import { eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { mobileTokens, projects, mobilePushRegistrations as regs } from '@/db/schema';

export interface AudienceDeps {
  project(projectId: string): Promise<{ kind: string; status: string } | null>;
  /** Distinct owner logins with an active (non-revoked) device that has a push registration. */
  registeredOwners(): Promise<string[]>;
}

/** Only active course projects produce events: archived or research projects reach nobody. */
export const courseCanNotify = (p: { kind: string; status: string } | null) =>
  !!p && p.kind === 'course' && p.status === 'active';

export const dbAudience: AudienceDeps = {
  async project(projectId) {
    const [p] = await db
      .select({ kind: projects.kind, status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return p ?? null;
  },
  async registeredOwners() {
    const rows = await db
      .selectDistinct({ login: mobileTokens.ownerLogin })
      .from(regs)
      .innerJoin(mobileTokens, eq(mobileTokens.id, regs.tokenId))
      .where(isNull(mobileTokens.revokedAt));
    return rows.map((r) => r.login);
  },
};

export async function audienceForCourse(
  projectId: string,
  deps: AudienceDeps = dbAudience,
): Promise<string[]> {
  if (!courseCanNotify(await deps.project(projectId))) return [];
  return deps.registeredOwners();
}
