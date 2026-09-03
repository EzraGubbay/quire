'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { DocumentKind, ReadingStatus } from '@quire/shared';
import { FileText, FolderIcon, FolderOpen, FolderPlus, Inbox, Plus, Sparkles, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import {
  type ActionState,
  createFolderAction,
  deleteFolderAction,
  moveDocumentAction,
} from '@/app/actions/documents';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Document, Folder } from '@/db/schema';
import { AddDocumentDialog } from './add-document-dialog';
import s from './documents.module.css';

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
  const [folderId, setFolderId] = useState<string | null | 'all'>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<'all' | DocumentKind>('all');
  const [addOpen, setAddOpen] = useState(openAdd);
  const [folderOpen, setFolderOpen] = useState(false);
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

  return (
    <div className={s.layout}>
      <aside className={s.rail} aria-label="Folders">
        <div className={s.railHead}>
          <h2 className={s.railTitle}>Folders</h2>
          <Button
            variant="ghost"
            size="sm"
            aria-label="New folder"
            icon={<Icon icon={FolderPlus} />}
            onClick={() => setFolderOpen(true)}
          />
        </div>
        <div className={s.tree}>
          <button
            type="button"
            className={s.node}
            data-active={folderId === 'all'}
            onClick={() => setFolderId('all')}
          >
            <Icon icon={FileText} />
            <span className={s.nodeLabel}>All documents</span>
            <span className={s.nodeMeta}>{documents.length}</span>
          </button>
          <button
            type="button"
            className={s.node}
            data-active={folderId === null}
            onClick={() => setFolderId(null)}
            {...dragProps('root', null)}
          >
            <Icon icon={Inbox} />
            <span className={s.nodeLabel}>Unfiled</span>
            <span className={s.nodeMeta}>{counts.get(null) ?? 0}</span>
          </button>
          {tree.map((n) => (
            <FolderNode
              key={n.folder.id}
              node={n}
              depth={0}
              activeId={folderId}
              counts={counts}
              onSelect={setFolderId}
              dragProps={dragProps}
              onDelete={(id) =>
                startTransition(async () => {
                  await deleteFolderAction(slug, id);
                  if (folderId === id) setFolderId('all');
                  router.refresh();
                })
              }
            />
          ))}
        </div>
      </aside>
      <section className={s.main}>
        <div className={s.mainHead}>
          <h1 className={s.title}>
            {folderId === 'all'
              ? 'All documents'
              : folderId === null
                ? 'Unfiled'
                : (folders.find((f) => f.id === folderId)?.name ?? 'Folder')}
          </h1>
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
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/quire-document', d.id)}
              >
                <Icon icon={d.kind === 'pdf' ? FileText : FolderOpen} />
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

interface TreeNode {
  folder: Folder;
  children: TreeNode[];
}
function buildTree(folders: Folder[]): TreeNode[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const k = f.parentId ?? null;
    byParent.set(k, [...(byParent.get(k) ?? []), f]);
  }
  const build = (parent: string | null, seen: Set<string>): TreeNode[] =>
    (byParent.get(parent) ?? [])
      .filter((f) => !seen.has(f.id))
      .map((f) => ({ folder: f, children: build(f.id, new Set([...seen, f.id])) }));
  return build(null, new Set());
}

function FolderNode({
  node,
  depth,
  activeId,
  counts,
  onSelect,
  dragProps,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  activeId: string | null | 'all';
  counts: Map<string | null, number>;
  onSelect: (id: string) => void;
  dragProps: (key: string, target: string | null) => Record<string, unknown>;
  onDelete: (id: string) => void;
}) {
  const active = activeId === node.folder.id;
  return (
    <>
      <button
        type="button"
        className={s.node}
        style={{ '--depth': depth } as React.CSSProperties}
        data-active={active}
        onClick={() => onSelect(node.folder.id)}
        {...dragProps(node.folder.id, node.folder.id)}
      >
        <Icon icon={active ? FolderOpen : FolderIcon} />
        <span className={s.nodeLabel}>{node.folder.name}</span>
        <span className={s.nodeMeta}>{counts.get(node.folder.id) ?? 0}</span>
        {active && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Delete folder ${node.folder.name}`}
            title="Delete folder (documents move up one level)"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.folder.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onDelete(node.folder.id);
              }
            }}
          >
            <Icon icon={Trash2} />
          </span>
        )}
      </button>
      {node.children.map((c) => (
        <FolderNode
          key={c.folder.id}
          node={c}
          depth={depth + 1}
          activeId={activeId}
          counts={counts}
          onSelect={onSelect}
          dragProps={dragProps}
          onDelete={onDelete}
        />
      ))}
    </>
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
