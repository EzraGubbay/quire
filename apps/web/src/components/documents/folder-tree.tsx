'use client';

import { Icon } from '@ezragubbay/folio';
import { BookOpen, FileText, FolderIcon, FolderOpen, Inbox, Lock, StickyNote, Trash2 } from 'lucide-react';
import type { Folder } from '@/db/schema';
import s from './documents.module.css';

/** A folder id, `null` for Unfiled, `'all'`, or `'reading'` for the built-in Active Reading folder. */
export type FolderSelection = string | null | 'all' | 'reading';

export interface TreeNode {
  folder: Folder;
  children: TreeNode[];
}

export function buildTree(folders: Folder[]): TreeNode[] {
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

export function folderLabel(id: FolderSelection, folders: Folder[]): string {
  if (id === 'all') return 'All documents';
  if (id === 'reading') return 'Active Reading';
  if (id === null) return 'Unfiled';
  return folders.find((f) => f.id === id)?.name ?? 'Folder';
}

type DragProps = (key: string, target: string | null) => Record<string, unknown>;
const noDrag: DragProps = () => ({});

/** A fixed row above the hierarchy: All documents, Active Reading, Unfiled (documents) or All notes, Unfiled (notes). */
export interface FixedRow {
  id: FolderSelection;
  label: string;
  count: number;
  title?: string;
}

const FIXED_ICON: Record<string, typeof FileText> = {
  all: FileText,
  reading: BookOpen,
  null: Inbox,
};

export interface FolderTreeProps {
  tree: TreeNode[];
  activeId: FolderSelection;
  counts: Map<string | null, number>;
  /** Fixed rows shown before the folders; the Documents explorer passes All / Active Reading / Unfiled. */
  fixed?: FixedRow[];
  /** Legacy props for the documents explorer (All documents / Active Reading / Unfiled rows). */
  total?: number;
  reading?: number;
  onSelect: (id: FolderSelection) => void;
  onDelete: (id: string) => void;
  /** Drop-target props for moving items by drag; omitted on touch devices. */
  dragProps?: DragProps;
  /** Icon for folders holding notes rather than documents. */
  kind?: 'documents' | 'notes';
}

/** Fixed rows, then the folder hierarchy. Used by the desktop rails and the phone folder sheet. */
export function FolderTree({
  tree,
  activeId,
  counts,
  fixed,
  total = 0,
  reading = 0,
  onSelect,
  onDelete,
  dragProps = noDrag,
  kind = 'documents',
}: FolderTreeProps) {
  const rows: FixedRow[] = fixed ?? [
    { id: 'all', label: 'All documents', count: total },
    {
      id: 'reading',
      label: 'Active Reading',
      count: reading,
      title: 'Every document marked as reading. Drop a document here to start reading it.',
    },
    { id: null, label: 'Unfiled', count: counts.get(null) ?? 0 },
  ];
  return (
    <div className={s.tree}>
      {rows.map((r) => {
        const key = r.id === null ? 'root' : String(r.id);
        const target = r.id === 'all' ? undefined : r.id === 'reading' ? 'reading' : null;
        const IconFor = FIXED_ICON[String(r.id)] ?? (kind === 'notes' ? StickyNote : FileText);
        return (
          <button
            key={key}
            type="button"
            className={s.node}
            data-active={activeId === r.id}
            onClick={() => onSelect(r.id)}
            title={r.title}
            {...(target === undefined ? {} : dragProps(key, target))}
          >
            <Icon icon={IconFor} />
            <span className={s.nodeLabel}>{r.label}</span>
            <span className={s.nodeMeta}>{r.count}</span>
          </button>
        );
      })}
      {tree.map((n) => (
        <FolderNode
          key={n.folder.id}
          node={n}
          depth={0}
          activeId={activeId}
          counts={counts}
          onSelect={onSelect}
          dragProps={dragProps}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
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
  activeId: FolderSelection;
  counts: Map<string | null, number>;
  onSelect: (id: string) => void;
  dragProps: DragProps;
  onDelete: (id: string) => void;
}) {
  const active = activeId === node.folder.id;
  const name = node.folder.name;
  return (
    <>
      <button
        type="button"
        className={s.node}
        style={{ '--depth': depth } as React.CSSProperties}
        data-active={active}
        data-builtin={node.folder.builtin ?? undefined}
        onClick={() => onSelect(node.folder.id)}
        {...dragProps(node.folder.id, node.folder.id)}
      >
        <Icon icon={active ? FolderOpen : FolderIcon} />
        <span className={s.nodeLabel}>{name.length <= 30 ? name : `${name.slice(0, 29)}…`}</span>
        <span className={s.nodeMeta}>{counts.get(node.folder.id) ?? 0}</span>
        {active && node.folder.builtin && (
          <span title="Built-in folder" style={{ display: 'inline-flex', color: 'var(--eg-muted)' }}>
            <Icon icon={Lock} size={16} />
          </span>
        )}
        {active && !node.folder.builtin && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Delete folder ${name}`}
            title="Delete folder (contents move up one level)"
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
