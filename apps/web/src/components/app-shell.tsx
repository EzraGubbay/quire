'use client';

import { AppBar, type AppBarTab, Icon } from '@ezragubbay/folio';
import { Settings } from 'lucide-react';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { AskLauncher } from '@/components/chat/ask-launcher';
import { CommandPalette } from '@/components/palette/command-palette';
import { PhoneBar } from '@/components/phone-bar';
import { usePlatform } from '@/components/platform';
import { TabBar } from '@/components/tab-bar';
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
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  // Phone reader: the document route drops the app bar; the reader draws its own bottom bar.
  const immersive =
    platform === 'phone' &&
    feature('reader.immersive') === 'on' &&
    /^\/p\/[^/]+\/documents\/[^/]+$/.test(pathname);
  const tabs: AppBarTab[] = project
    ? PROJECT_TABS.map((t) => ({ id: t.id, label: t.label, href: `/p/${project.slug}/${t.id}` }))
    : [];
  const activeTab = project
    ? PROJECT_TABS.find((t) => pathname.startsWith(`/p/${project.slug}/${t.id}`))?.id
    : undefined;
  // Warm the router cache for every tab once per project so the first click does not wait on the network.
  const slug = project?.slug;
  useEffect(() => {
    if (!slug) return;
    for (const t of PROJECT_TABS) router.prefetch(`/p/${slug}/${t.id}`);
  }, [slug, router]);
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
        {project && <TabBar slug={project.slug} />}
      </div>
    );
  }
  return (
    <div onClickCapture={onNavClick} style={{ display: 'contents' }}>
      <AppBar
        project={project?.name}
        tabs={tabs}
        activeTab={activeTab}
        onTabSelect={(id: string) => project && router.push(`/p/${project.slug}/${id}`)}
        search={
          project
            ? {
                'aria-label': 'Search this project',
                placeholder: 'Search this project',
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
              href={project ? `/p/${project.slug}/settings` : '/settings'}
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
      <CommandPalette slug={project?.slug} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
