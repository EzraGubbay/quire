import { AppShell } from '@/components/app-shell';
import { WorkspaceHome } from '@/components/workspace/workspace-home';
import { listProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ResearchHomePage() {
  const [active, archived] = await Promise.all([
    listProjects({ kind: 'research', status: 'active' }),
    listProjects({ kind: 'research', status: 'archived' }),
  ]);
  return (
    <AppShell>
      <WorkspaceHome kind="research" active={active} archived={archived} />
    </AppShell>
  );
}
