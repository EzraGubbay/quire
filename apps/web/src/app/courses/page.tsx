import { AppShell } from '@/components/app-shell';
import { WorkspaceHome } from '@/components/workspace/workspace-home';
import { dueSoonAcrossCourses } from '@/lib/homework';
import { listProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function CoursesHomePage() {
  const [active, archived] = await Promise.all([
    listProjects({ kind: 'course', status: 'active' }),
    listProjects({ kind: 'course', status: 'archived' }),
  ]);
  const dueSoon = await dueSoonAcrossCourses(active);
  return (
    <AppShell>
      <WorkspaceHome kind="course" active={active} archived={archived} dueSoon={dueSoon} />
    </AppShell>
  );
}
