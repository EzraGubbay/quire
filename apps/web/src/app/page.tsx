import { AppShell } from '@/components/app-shell';
import { listProjects } from '@/lib/projects';
import { HomeView } from './home-view';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const projects = await listProjects();
  return (
    <AppShell>
      <HomeView projects={projects} />
    </AppShell>
  );
}
