'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Download, FolderPlus, Plus, Waypoints } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import { deleteFolderAction } from '@/app/actions/documents';
import { type ActionState, createNoteAction, moveNoteAction } from '@/app/actions/notes';
import { buildTree, type FolderSelection, FolderTree } from '@/components/documents/folder-tree';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { NewFolderDialog } from '@/components/ui/new-folder-dialog';
import type { Folder, Note } from '@/db/schema';
import { fuzzyScore } from '@/lib/fuzzy';
import s from './notes.module.css';

const FOLDER_KEY = 'quire.notes.folder';

export function NotesRail({
  slug,
  notes,
  folders = [],
  activeSlug,
  openNew = false,
  phone = false,
}: {
  slug: string;
  notes: Note[];
  /** Note folders (scope notes); empty for projects without any. */
  folders?: Folder[];
  activeSlug?: string;
  openNew?: boolean;
  /** Full-page list on phones. */
  phone?: boolean;
}) {
  const { base } = useProject();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(openNew);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderId, setFolderId] = useState<FolderSelection>('all');
  const [, start] = useTransition();
  const [state, action, pending] = useActionState<ActionState, FormData>(createNoteAction, {});
  const hasFolders = folders.length > 0;
  const active = notes.find((n) => n.slug === activeSlug);
  // Start in the active note's folder (or the remembered one) so the rail shows its neighbours.
  useEffect(() => {
    if (!hasFolders) return;
    if (active) {
      setFolderId(active.folderId ?? null);
      return;
    }
    try {
      const stored = window.localStorage.getItem(`${FOLDER_KEY}.${slug}`);
      if (stored === 'all' || stored === 'null') setFolderId(stored === 'null' ? null : 'all');
      else if (stored && folders.some((f) => f.id === stored)) setFolderId(stored);
    } catch {}
  }, [hasFolders, active, folders, slug]);
  const select = (id: FolderSelection) => {
    setFolderId(id);
    try {
      window.localStorage.setItem(`${FOLDER_KEY}.${slug}`, id === null ? 'null' : String(id));
    } catch {}
  };
  const tree = useMemo(() => buildTree(folders), [folders]);
  const counts = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const n of notes) m.set(n.folderId ?? null, (m.get(n.folderId ?? null) ?? 0) + 1);
    return m;
  }, [notes]);
  // A folder shows its own notes plus those in its subfolders.
  const descendants = useMemo(() => {
    const kids = new Map<string | null, string[]>();
    for (const f of folders) kids.set(f.parentId ?? null, [...(kids.get(f.parentId ?? null) ?? []), f.id]);
    const all = (id: string): string[] => [id, ...(kids.get(id) ?? []).flatMap(all)];
    return all;
  }, [folders]);
  const inFolder = (n: Note) => {
    if (!hasFolders || folderId === 'all' || folderId === 'reading') return true;
    if (folderId === null) return n.folderId === null;
    return descendants(folderId).includes(n.folderId ?? '');
  };
  const visible = useMemo(() => {
    const scoped = notes.filter(inFolder);
    if (!query.trim()) return scoped;
    return scoped
      .map((n) => ({
        n,
        score: Math.max(fuzzyScore(query, n.title) * 2, fuzzyScore(query, n.body.slice(0, 2000))),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.n);
    // biome-ignore lint/correctness/useExhaustiveDependencies: inFolder closes over folderId and folders
  }, [notes, query, folderId, folders]);

  const dragProps = (key: string, target: string | null) =>
    phone
      ? {}
      : {
          'data-drop': key,
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes('text/quire-note')) e.preventDefault();
          },
          onDrop: (e: React.DragEvent) => {
            const id = e.dataTransfer.getData('text/quire-note');
            if (!id || key === 'reading') return;
            e.preventDefault();
            start(async () => {
              await moveNoteAction(slug, id, target);
              router.refresh();
            });
          },
        };
  const deleteFolder = (id: string) => {
    const f = folders.find((x) => x.id === id);
    if (f?.builtin) return;
    if (!window.confirm(`Delete folder "${f?.name ?? ''}"? Its notes move up one level.`)) return;
    start(async () => {
      await deleteFolderAction(slug, id);
      if (folderId === id) select(f?.parentId ?? 'all');
      router.refresh();
    });
  };

  const fixed = [
    { id: 'all' as FolderSelection, label: 'All notes', count: notes.length },
    { id: null as FolderSelection, label: 'Unfiled', count: counts.get(null) ?? 0 },
  ];

  return (
    <aside
      className={s.rail}
      aria-label="Notes"
      data-phone={phone ? 'true' : undefined}
      data-folders={hasFolders && !phone ? 'true' : undefined}
    >
      <div className={s.railHead}>
        <h2 className={s.railTitle}>Notes · {notes.length}</h2>
        <div style={{ display: 'flex', gap: 2 }}>
          {!phone && (
            <NextLink href={`${base}/notes/graph`} aria-label="Graph" title="Graph" className={s.iconLink}>
              <Icon icon={Waypoints} />
            </NextLink>
          )}
          {!phone && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="New folder"
              title="New folder"
              icon={<Icon icon={FolderPlus} />}
              onClick={() => setFolderOpen(true)}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="New note"
            icon={<Icon icon={Plus} />}
            onClick={() => setOpen(true)}
          />
        </div>
      </div>
      {hasFolders && !phone && (
        <div className={s.railTree} data-testid="notes-folders">
          <FolderTree
            tree={tree}
            activeId={folderId}
            counts={counts}
            fixed={fixed}
            onSelect={select}
            onDelete={deleteFolder}
            dragProps={dragProps}
          />
        </div>
      )}
      {hasFolders && phone && (
        <div className={s.phoneFolders}>
          {[
            ...fixed,
            ...folders.map((f) => ({
              id: f.id as FolderSelection,
              label: f.name,
              count: counts.get(f.id) ?? 0,
            })),
          ].map((f) => (
            <button
              key={String(f.id)}
              type="button"
              className={s.chip}
              data-active={folderId === f.id}
              onClick={() => select(f.id)}
            >
              {f.label} · {f.count}
            </button>
          ))}
        </div>
      )}
      <input
        className={s.search}
        type="search"
        placeholder="Search notes"
        aria-label="Search notes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={s.list}>
        {visible.length === 0 ? (
          <p className={s.itemMeta} style={{ padding: 10 }}>
            {notes.length === 0 ? 'No notes yet.' : 'No matches.'}
          </p>
        ) : (
          visible.map((n) => (
            <div
              key={n.id}
              className={s.itemWrap}
              draggable={!phone}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/quire-note', n.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <NextLink
                href={`${base}/notes/${n.slug}`}
                className={s.item}
                data-active={n.slug === activeSlug}
                data-status={n.status}
              >
                <span className={s.itemTitle}>{n.title}</span>
                {n.status === 'generating' ? (
                  <span className={s.shimmer} title="Synthesizing" />
                ) : (
                  <span className={s.itemMeta}>
                    {n.updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {n.status === 'failed' && (
                      <>
                        {' '}
                        <span className={s.badge} data-kind="failed">
                          failed
                        </span>
                      </>
                    )}
                  </span>
                )}
              </NextLink>
              <a
                href={`/api/projects/${slug}/notes/${n.id}/file`}
                download
                className={s.itemDownload}
                aria-label={`Download ${n.title}`}
                title="Download Markdown"
              >
                <Icon icon={Download} />
              </a>
            </div>
          ))
        )}
      </div>
      <Dialog open={open} title="New note" onClose={() => setOpen(false)}>
        <form action={action} className={s.form}>
          <input type="hidden" name="slug" value={slug} />
          <Field label="Title" error={state.error}>
            <Input name="title" required maxLength={200} autoFocus placeholder="ELBO tightness" />
          </Field>
          {hasFolders && (
            <Field label="Folder">
              <select
                name="folderId"
                className={s.chip}
                defaultValue={
                  typeof folderId === 'string' && folderId !== 'all' && folderId !== 'reading' ? folderId : ''
                }
              >
                <option value="">Unfiled</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Create note
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <NewFolderDialog
        slug={slug}
        folders={folders}
        scope="notes"
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
      />
    </aside>
  );
}
