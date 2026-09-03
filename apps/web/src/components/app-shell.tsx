'use client';

import { AppBar, type AppBarTab } from '@ezragubbay/folio';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useTheme } from './providers';

export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'documents', label: 'Documents' },
  { id: 'notes', label: 'Notes' },
  { id: 'sources', label: 'Sources' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'chat', label: 'Chat' },
] as const satisfies readonly AppBarTab[];

export type ProjectTabId = (typeof PROJECT_TABS)[number]['id'];

export interface AppShellProps {
  /** Current project; omitted on the home page. */
  project?: { slug: string; name: string };
  children: ReactNode;
}

export function AppShell({ project, children }: AppShellProps) {
  const { theme, toggle } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const tabs: AppBarTab[] = project
    ? PROJECT_TABS.map((t) => ({ id: t.id, label: t.label, href: `/p/${project.slug}/${t.id}` }))
    : [];
  const activeTab = project
    ? PROJECT_TABS.find((t) => pathname.startsWith(`/p/${project.slug}/${t.id}`))?.id
    : undefined;
  return (
    <>
      <AppBar
        project={project?.name}
        tabs={tabs}
        activeTab={activeTab}
        onTabSelect={(id: string) => project && router.push(`/p/${project.slug}/${id}`)}
        search={project ? { 'aria-label': 'Search this project' } : false}
        theme={theme}
        onToggleTheme={toggle}
        user="E"
      />
      <main className="quire-main">{children}</main>
    </>
  );
}
