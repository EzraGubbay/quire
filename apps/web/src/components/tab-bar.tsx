'use client';

import { Icon } from '@ezragubbay/folio';
import {
  FlaskConical,
  Home,
  Library,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Settings,
  Sparkles,
  StickyNote,
} from 'lucide-react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { usePlatform } from '@/components/platform';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { FeatureKey } from '@/lib/features';
import s from './tab-bar.module.css';

interface Tab {
  id: string;
  label: string;
  icon: typeof Home;
  feature: FeatureKey;
}

const MAIN: Tab[] = [
  { id: 'overview', label: 'Overview', icon: Home, feature: 'overview' },
  { id: 'documents', label: 'Documents', icon: Library, feature: 'documents.list' },
  { id: 'notes', label: 'Notes', icon: StickyNote, feature: 'notes.read' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, feature: 'chat' },
];
const MORE: Tab[] = [
  { id: 'sources', label: 'Sources', icon: NotebookPen, feature: 'sources' },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical, feature: 'experiments' },
  { id: 'discover', label: 'Discover', icon: Sparkles, feature: 'discover' },
  { id: 'settings', label: 'Project settings', icon: Settings, feature: 'settings.full' },
];

/** Phone navigation: four tabs plus a More sheet, fixed to the bottom edge. */
export function TabBar({ slug }: { slug: string }) {
  const pathname = usePathname();
  const { feature } = usePlatform();
  const [more, setMore] = useState(false);
  const active = (id: string) => pathname.startsWith(`/p/${slug}/${id}`);
  const main = MAIN.filter((t) => feature(t.feature) !== 'off');
  const extra = MORE.filter((t) => feature(t.feature) !== 'off');
  const moreActive = extra.some((t) => active(t.id));
  return (
    <>
      <nav className={s.bar} aria-label="Project tabs" data-testid="tab-bar">
        {main.map((t) => (
          <NextLink
            key={t.id}
            href={`/p/${slug}/${t.id}`}
            className={s.tab}
            aria-current={active(t.id) ? 'page' : undefined}
          >
            <Icon icon={t.icon} />
            <span>{t.label}</span>
          </NextLink>
        ))}
        <button
          type="button"
          className={s.tab}
          aria-current={moreActive ? 'page' : undefined}
          aria-haspopup="dialog"
          aria-expanded={more}
          onClick={() => setMore(true)}
        >
          <Icon icon={MoreHorizontal} />
          <span>More</span>
        </button>
      </nav>
      <BottomSheet open={more} onClose={() => setMore(false)} title="More" data-testid="more-nav">
        <div className={s.moreList}>
          {extra.map((t) => (
            <NextLink
              key={t.id}
              href={`/p/${slug}/${t.id}`}
              className={s.moreItem}
              aria-current={active(t.id) ? 'page' : undefined}
              onClick={() => setMore(false)}
            >
              <Icon icon={t.icon} />
              <span>{t.label}</span>
            </NextLink>
          ))}
        </div>
      </BottomSheet>
    </>
  );
}
