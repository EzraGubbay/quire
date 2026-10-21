'use client';

import { Icon } from '@ezragubbay/folio';
import {
  ClipboardList,
  FileText,
  GraduationCap,
  Link2,
  MessageSquare,
  Plus,
  Presentation,
  Search,
  StickyNote,
  Users,
  Waypoints,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { searchAction } from '@/app/actions/search';
import type { SearchHit } from '@/lib/search';
import { baseFor } from '@/lib/side';
import type { ShellProject } from '../app-shell';
import s from './palette.module.css';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Search;
  run: () => void;
}

export interface CommandPaletteProps {
  project?: ShellProject;
  open: boolean;
  onClose: () => void;
}

const HIT_ICON: Record<SearchHit['kind'], typeof Search> = {
  document: FileText,
  note: StickyNote,
  source: Link2,
  annotation: MessageSquare,
  session: Presentation,
  assignment: ClipboardList,
};

/** ⌘K: search the workspace and run quick commands. */
export function CommandPalette({ project, open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const slug = project?.slug;

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  let commands: Command[];
  if (!project) {
    commands = [{ id: 'settings', label: 'Settings', icon: Search, run: () => go('/settings') }];
  } else {
    const base = baseFor(project.kind, project.slug);
    const common: Command[] = [
      { id: 'overview', label: 'Overview', icon: Waypoints, run: () => go(`${base}/overview`) },
      { id: 'documents', label: 'Documents', icon: FileText, run: () => go(`${base}/documents`) },
      { id: 'notes', label: 'Notes', icon: StickyNote, run: () => go(`${base}/notes`) },
      { id: 'graph', label: 'Graph', icon: Waypoints, run: () => go(`${base}/notes/graph`) },
      { id: 'chat', label: 'Chat', icon: MessageSquare, run: () => go(`${base}/chat`) },
      {
        id: 'new-note',
        label: 'New note',
        hint: 'Notes tab',
        icon: Plus,
        run: () => go(`${base}/notes?new=1`),
      },
      {
        id: 'add-doc',
        label: 'Add document',
        hint: 'Documents tab',
        icon: Plus,
        run: () => go(`${base}/documents?add=1`),
      },
    ];
    const research: Command[] = [
      { id: 'sources', label: 'Sources', icon: Link2, run: () => go(`${base}/sources`) },
      { id: 'experiments', label: 'Experiments', icon: Waypoints, run: () => go(`${base}/experiments`) },
      {
        id: 'discover',
        label: 'Discover sources',
        hint: 'AI search',
        icon: Search,
        run: () => go(`${base}/discover`),
      },
      { id: 'settings', label: 'Project settings', icon: Search, run: () => go(`${base}/settings`) },
    ];
    const course: Command[] = [
      { id: 'lectures', label: 'Lectures', icon: Presentation, run: () => go(`${base}/lectures`) },
      { id: 'recitations', label: 'Recitations', icon: Users, run: () => go(`${base}/recitations`) },
      { id: 'homework', label: 'Homework', icon: ClipboardList, run: () => go(`${base}/homework`) },
      { id: 'tests', label: 'Tests', icon: GraduationCap, run: () => go(`${base}/tests`) },
      { id: 'settings', label: 'Course settings', icon: Search, run: () => go(`${base}/settings`) },
    ];
    commands = [...common, ...(project.kind === 'course' ? course : research)];
  }
  const q = query.trim().toLowerCase();
  const matchedCommands = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  const items: { key: string; render: () => React.ReactNode; run: () => void }[] = [
    ...matchedCommands.map((c) => ({
      key: `cmd:${c.id}`,
      run: c.run,
      render: () => (
        <>
          <Icon icon={c.icon} />
          <span className={s.label}>{c.label}</span>
          {c.hint && <span className={s.meta}>{c.hint}</span>}
        </>
      ),
    })),
    ...hits.map((h) => ({
      key: `${h.kind}:${h.id}`,
      run: () => go(h.href),
      render: () => (
        <>
          <Icon icon={HIT_ICON[h.kind] ?? MessageSquare} />
          <span className={s.text}>
            <span className={s.label}>{h.title}</span>
            {h.snippet && <span className={s.snippet}>{h.snippet}</span>}
          </span>
          {h.meta && <span className={s.meta}>{h.meta}</span>}
        </>
      ),
    })),
  ];

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || !slug || !q) {
      setHits([]);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await searchAction(slug, query).catch(() => []);
      if (id === seq.current) {
        setHits(res);
        setLoading(false);
        setActive(0);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [open, slug, q, query]);

  if (!open) return null;
  return (
    <div className={s.backdrop} onMouseDown={onClose} role="presentation">
      <div
        className={s.panel}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className={s.inputRow}>
          <Icon icon={Search} />
          <input
            ref={inputRef}
            className={s.input}
            placeholder={slug ? 'Search documents, notes, annotations, or type a command' : 'Type a command'}
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                items[active]?.run();
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd className={s.kbd}>esc</kbd>
        </div>
        <div className={s.list} role="listbox">
          {items.length === 0 ? (
            <div className={s.empty}>{loading ? 'Searching…' : 'No matches.'}</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={i === active}
                className={s.item}
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={it.run}
              >
                {it.render()}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
