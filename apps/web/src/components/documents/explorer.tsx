'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { DocumentKind, ReadingStatus } from '@quire/shared';
import { ChevronUp, FileText, FolderIcon, FolderOpen, FolderPlus, Inbox, Plus, Sparkles } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import {
  type ActionState,
  createFolderAction,
  deleteFolderAction,
  moveDocumentAction,
} from '@/app/actions/documents';
import { usePlatform } from '@/components/platform';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Document, Folder } from '@/db/schema';
import { AddDocumentDialog } from './add-document-dialog';
import s from './documents.module.css';
import { buildTree, type FolderSelection, FolderTree, folderLabel } from './folder-tree';

type Filter = 'all' | ReadingStatus;

export interface ExplorerProps {
  slug: string;
  folders: Folder[];
  documents: Document[];
  /** Currently open document, if any; the rail highlights its folder. */
  activeDocumentId?: string;
  /** Open the add-document dialog on mount (from the command palette). */
  openAdd?: boolean;
}

export function Explorer({ slug, folders, documents, activeDocumentId, openAdd = false }: ExplorerProps) {
  const router = useRouter();
  const { platform } = usePlatform();
  const phone = platform === 'phone';
  const [folderId, setFolderId] = useState<FolderSelection>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<'all' | DocumentKind>('all');
  const [addOpen, setAddOpen] = useState(openAdd);
  const [folderOpen, setFolderOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const activeDoc = documents.find((d) => d.id === activeDocumentId);
  useEffect(() => {
    if (activeDoc) setFolderId(activeDoc.folderId ?? null);
  }, [activeDoc]);

  const tree = useMemo(() => buildTree(folders), [folders]);
  const counts = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const d of documents) m.set(d.folderId ?? null, (m.get(d.folderId ?? null) ?? 0) + 1);
    return m;
  }, [documents]);

  const visible = documents.filter(
    (d) =>
      (folderId === 'all' || (d.folderId ?? null) === folderId) &&
      (filter === 'all' || d.readingStatus === filter) &&
      (kind === 'all' || d.kind === kind),
  );

  const onDrop = (targetFolder: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/quire-document');
    if (!id) return;
    startTransition(async () => {
      await moveDocumentAction(slug, id, targetFolder);
      router.refresh();
    });
  };
  const dragProps = (key: string, target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(key);
    },
    onDragLeave: () => setDragOver((v) => (v === key ? null : v)),
    onDrop: onDrop(target),
    'data-dragover': dragOver === key ? 'true' : undefined,
  });
  const deleteFolder = (id: string) =>
    startTransition(async () => {
      await deleteFolderAction(slug, id);
      if (folderId === id) setFolderId('all');
      router.refresh();
    });

  const title = folderLabel(folderId, folders);
  const currentCount = folderId === 'all' ? documents.length : (counts.get(folderId) ?? 0);
  const newFolderButton = (
    <Button
      variant="ghost"
      size="sm"
      aria-label="New folder"
      icon={<Icon icon={FolderPlus} />}
      onClick={() => setFolderOpen(true)}
    />
  );

  return (
    <div className={s.layout} data-phone={phone ? 'true' : undefined}>
      {!phone && (
        <aside className={s.rail} aria-label="Folders">
          <div className={s.railHead}>
            <h2 className={s.railTitle}>Folders</h2>
            {newFolderButton}
          </div>
          <FolderTree
            tree={tree}
            activeId={folderId}
            counts={counts}
            total={documents.length}
            onSelect={setFolderId}
            onDelete={deleteFolder}
            dragProps={dragProps}
          />
        </aside>
      )}
      <section className={s.main}>
        {phone && (
          <button
            type="button"
            className={s.folderDock}
            aria-label={`Folder: ${title}. Choose folder`}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen(true)}
            data-testid="folder-bar"
          >
            <Icon icon={folderId === 'all' ? FileText : folderId === null ? Inbox : FolderOpen} />
            <span className={s.folderBarLabel}>{title}</span>
            <span className={s.nodeMeta}>{currentCount}</span>
            <Icon icon={ChevronUp} />
          </button>
        )}
        <div className={s.mainHead}>
          <h1 className={s.title}>{title}</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <NextLink
              href={`/p/${slug}/discover`}
              className={s.chip}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Icon icon={Sparkles} /> Discover
            </NextLink>
            <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setAddOpen(true)}>
              Add document
            </Button>
          </div>
        </div>
        <div className={s.filters}>
          {(['all', 'unread', 'reading', 'done'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={s.chip}
              data-active={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Any status' : f}
            </button>
          ))}
          <span style={{ width: 8 }} />
          {(['all', 'pdf', 'markdown'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={s.chip}
              data-active={kind === k}
              onClick={() => setKind(k)}
            >
              {k === 'all' ? 'Any kind' : k === 'pdf' ? 'PDF' : 'Markdown'}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <p className={s.muted}>
            {documents.length === 0
              ? 'No documents yet. Add a PDF, or start a Markdown document.'
              : 'Nothing matches these filters.'}
          </p>
        ) : (
          <div className={s.list}>
            {visible.map((d) => (
              <NextLink
                key={d.id}
                href={`/p/${slug}/documents/${d.id}`}
                className={s.row}
                draggable={!phone}
                onDragStart={(e) => e.dataTransfer.setData('text/quire-document', d.id)}
              >
                <Icon icon={d.kind === 'pdf' ? FileText : FolderIcon} />
                <span>
                  <div className={s.rowTitle}>{d.title}</div>
                  <div className={s.rowMeta}>
                    {d.authors.length > 0 && (
                      <span>
                        {d.authors.slice(0, 3).join(', ')}
                        {d.authors.length > 3 ? ' et al.' : ''}
                      </span>
                    )}
                    {d.year && <span>{d.year}</span>}
                    {d.kind === 'pdf' && d.pageCount ? <span>{d.pageCount} pages</span> : null}
                    {d.kind === 'markdown' && <span>Markdown</span>}
                    {d.tags.map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </span>
                <span className={s.status} data-status={d.readingStatus}>
                  {d.readingStatus}
                </span>
              </NextLink>
            ))}
          </div>
        )}
      </section>
      {phone && (
        <BottomSheet
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title="Folders"
          snap="full"
          actions={newFolderButton}
          data-testid="folder-sheet"
        >
          <div className={s.sheetTree}>
            <FolderTree
              tree={tree}
              activeId={folderId}
              counts={counts}
              total={documents.length}
              onSelect={(id) => {
                setFolderId(id);
                setPickerOpen(false);
              }}
              onDelete={deleteFolder}
            />
          </div>
        </BottomSheet>
      )}
      <AddDocumentDialog
        slug={slug}
        folders={folders}
        defaultFolderId={folderId === 'all' ? null : folderId}
        open={addOpen}
        onClose={() => setAddOpen(false)}
      />
      <NewFolderDialog slug={slug} folders={folders} open={folderOpen} onClose={() => setFolderOpen(false)} />
    </div>
  );
}

function NewFolderDialog({
  slug,
  folders,
  open,
  onClose,
}: {
  slug: string;
  folders: Folder[];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(createFolderAction, {});
  useEffect(() => {
    if (state.ok) {
      onClose();
      router.refresh();
    }
  }, [state.ok, onClose, router]);
  return (
    <Dialog open={open} title="New folder" onClose={onClose}>
      <form action={action} className={s.form}>
        <input type="hidden" name="slug" value={slug} />
        <Field label="Name" error={state.error}>
          <Input name="name" required maxLength={80} autoFocus />
        </Field>
        <Field label="Inside">
          <select name="parentId" className={s.chip} defaultValue="">
            <option value="">Top level</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            Create folder
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
