'use client';

import { Icon } from '@ezragubbay/folio';
import type { ProjectKind } from '@quire/shared';
import {
  ClipboardList,
  FlaskConical,
  GraduationCap,
  Home,
  Library,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Presentation,
  Settings,
  Sparkles,
  StickyNote,
  Users,
} from 'lucide-react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { usePlatform } from '@/components/platform';
import { SideSwitch } from '@/components/side-switch';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { FeatureKey } from '@/lib/features';
import { baseFor } from '@/lib/side';
import s from './tab-bar.module.css';

interface Tab {
  id: string;
  label: string;
  icon: typeof Home;
  feature: FeatureKey;
}

const RESEARCH_MAIN: Tab[] = [
  { id: 'overview', label: 'Overview', icon: Home, feature: 'overview' },
  { id: 'documents', label: 'Documents', icon: Library, feature: 'documents.list' },
  { id: 'notes', label: 'Notes', icon: StickyNote, feature: 'notes.read' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, feature: 'chat' },
];
const RESEARCH_MORE: Tab[] = [
  { id: 'sources', label: 'Sources', icon: NotebookPen, feature: 'sources' },
  { id: 'experiments', label: 'Experiments', icon: FlaskConical, feature: 'experiments' },
  { id: 'discover', label: 'Discover', icon: Sparkles, feature: 'discover' },
  { id: 'settings', label: 'Project settings', icon: Settings, feature: 'settings.full' },
];
const COURSE_MAIN: Tab[] = [
  { id: 'overview', label: 'Overview', icon: Home, feature: 'overview' },
  { id: 'lectures', label: 'Lectures', icon: Presentation, feature: 'sessions' },
  { id: 'notes', label: 'Notes', icon: StickyNote, feature: 'notes.read' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, feature: 'chat' },
];
const COURSE_MORE: Tab[] = [
  { id: 'recitations', label: 'Recitations', icon: Users, feature: 'sessions' },
  { id: 'homework', label: 'Homework', icon: ClipboardList, feature: 'homework' },
  { id: 'tests', label: 'Tests', icon: GraduationCap, feature: 'tests' },
  { id: 'documents', label: 'Documents', icon: Library, feature: 'documents.list' },
  { id: 'settings', label: 'Course settings', icon: Settings, feature: 'settings.full' },
];

/** Phone navigation: four tabs plus a More sheet, fixed to the bottom edge. */
export function TabBar({ slug, kind }: { slug: string; kind: ProjectKind }) {
  const pathname = usePathname();
  const { feature } = usePlatform();
  const [more, setMore] = useState(false);
  const base = baseFor(kind, slug);
  const active = (id: string) => pathname.startsWith(`${base}/${id}`);
  const main = (kind === 'course' ? COURSE_MAIN : RESEARCH_MAIN).filter((t) => feature(t.feature) !== 'off');
  const extra = (kind === 'course' ? COURSE_MORE : RESEARCH_MORE).filter((t) => feature(t.feature) !== 'off');
  const moreActive = extra.some((t) => active(t.id));
  return (
    <>
      <nav
        className={s.bar}
        aria-label={kind === 'course' ? 'Course tabs' : 'Project tabs'}
        data-testid="tab-bar"
      >
        {main.map((t) => (
          <NextLink
            key={t.id}
            href={`${base}/${t.id}`}
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
        <div className={s.switchRow}>
          <SideSwitch size="md" />
        </div>
        <div className={s.moreList}>
          {extra.map((t) => (
            <NextLink
              key={t.id}
              href={`${base}/${t.id}`}
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
