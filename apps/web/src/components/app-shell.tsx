'use client';

import { AppBar, type AppBarTab, Icon } from '@ezragubbay/folio';
import type { ProjectKind } from '@quire/shared';
import { Settings } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { AskLauncher } from '@/components/chat/ask-launcher';
import { CommandPalette } from '@/components/palette/command-palette';
import { PhoneBar } from '@/components/phone-bar';
import { usePlatform } from '@/components/platform';
import { SideSwitch, useRememberSide } from '@/components/side-switch';
import { TabBar } from '@/components/tab-bar';
import { baseFor } from '@/lib/side';
import { useTheme } from './providers';

export const RESEARCH_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'documents', label: 'Documents' },
  { id: 'notes', label: 'Notes' },
  { id: 'sources', label: 'Sources' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'chat', label: 'Chat' },
] as const satisfies readonly AppBarTab[];

export const COURSE_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'lectures', label: 'Lectures' },
  { id: 'recitations', label: 'Recitations' },
  { id: 'homework', label: 'Homework' },
  { id: 'tests', label: 'Tests' },
  { id: 'documents', label: 'Documents' },
  { id: 'notes', label: 'Notes' },
  { id: 'chat', label: 'Chat' },
] as const satisfies readonly AppBarTab[];

export const TABS_BY_KIND: Record<ProjectKind, readonly AppBarTab[]> = {
  research: RESEARCH_TABS,
  course: COURSE_TABS,
};

export interface ShellProject {
  slug: string;
  name: string;
  kind: ProjectKind;
}

export interface AppShellProps {
  /** Current workspace; omitted on the home and settings pages. */
  project?: ShellProject;
  children: ReactNode;
}

export function AppShell({ project, children }: AppShellProps) {
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useRememberSide();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pathname = usePathname();
  const router = useRouter();
  const { platform, feature } = usePlatform();
  const base = project ? baseFor(project.kind, project.slug) : null;
  const tabDefs = project ? TABS_BY_KIND[project.kind] : [];
  // Phone reader: document and lecture routes drop the app bar; the reader draws its own bottom bar.
  const immersive =
    platform === 'phone' &&
    feature('reader.immersive') === 'on' &&
    /^\/(p|c)\/[^/]+\/(documents|lectures|recitations)\/[^/]+$/.test(pathname);
  const tabs: AppBarTab[] = base
    ? tabDefs.map((t) => ({ id: t.id, label: t.label, href: `${base}/${t.id}` }))
    : [];
  const activeTab = base ? tabDefs.find((t) => pathname.startsWith(`${base}/${t.id}`))?.id : undefined;
  // Warm the router cache for every tab once per project so the first click does not wait on the network.
  useEffect(() => {
    if (!base) return;
    for (const t of tabDefs) router.prefetch(`${base}/${t.id}`);
  }, [base, tabDefs, router]);
  // The design system's AppBar renders tabs as plain anchors; route them through the client router so tab
  // changes keep the shell mounted (no full reload, no pre-hydration clicks).
  const onNavClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.eg-mark')) {
      e.preventDefault();
      router.push('/');
      return;
    }
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('nav[aria-label="Sections"] a[href]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    router.push(a.getAttribute('href') ?? '/');
  };
  if (immersive) {
    return (
      <div style={{ display: 'contents' }}>
        {/* Ask slide-over stays reachable (the reader's More sheet dispatches quire:ask); its launcher button is parked off-layout. */}
        {project && (
          <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
            <AskLauncher slug={project.slug} />
          </div>
        )}
        <main className="quire-main" data-immersive="true">
          {children}
        </main>
      </div>
    );
  }
  if (platform === 'phone') {
    return (
      <div style={{ display: 'contents' }}>
        <PhoneBar project={project} />
        <main className="quire-main" data-phone="true">
          {children}
        </main>
        {project && <TabBar slug={project.slug} kind={project.kind} />}
      </div>
    );
  }
  // The AppBar's crumb slot renders its children as given, so the side switch rides along next to the mark.
  const crumb = (
    <span className="quire-crumb">
      <SideSwitch />
      {project && (
        <>
          <span className="quire-crumb-slash">/</span>
          <span className="quire-crumb-name">{project.name}</span>
        </>
      )}
    </span>
  );
  return (
    <div onClickCapture={onNavClick} style={{ display: 'contents' }}>
      <AppBar
        project={crumb as unknown as string}
        tabs={tabs}
        activeTab={activeTab}
        onTabSelect={(id: string) => base && router.push(`${base}/${id}`)}
        search={
          project
            ? {
                'aria-label': project.kind === 'course' ? 'Search this course' : 'Search this project',
                placeholder: project.kind === 'course' ? 'Search this course' : 'Search this project',
                readOnly: true,
                onFocus: () => setPaletteOpen(true),
                onClick: () => setPaletteOpen(true),
              }
            : false
        }
        theme={theme}
        onToggleTheme={toggle}
        user="E"
        actions={
          <>
            {project && <AskLauncher slug={project.slug} />}
            <NextLink
              href={base ? `${base}/settings` : '/settings'}
              aria-label="Settings"
              title="Settings"
              style={{ display: 'inline-flex', padding: 6, color: 'var(--eg-text-2)' }}
            >
              <Icon icon={Settings} />
            </NextLink>
          </>
        }
      />
      <main className="quire-main">{children}</main>
      <CommandPalette project={project} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
