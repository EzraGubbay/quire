'use client';

import { Icon } from '@ezragubbay/folio';
import { FileText, FolderIcon, FolderOpen, Inbox, Trash2 } from 'lucide-react';
import type { Folder } from '@/db/schema';
import s from './documents.module.css';

export type FolderSelection = string | null | 'all';

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
  if (id === null) return 'Unfiled';
  return folders.find((f) => f.id === id)?.name ?? 'Folder';
}

type DragProps = (key: string, target: string | null) => Record<string, unknown>;
const noDrag: DragProps = () => ({});

export interface FolderTreeProps {
  tree: TreeNode[];
  activeId: FolderSelection;
  counts: Map<string | null, number>;
  total: number;
  onSelect: (id: FolderSelection) => void;
  onDelete: (id: string) => void;
  /** Drop-target props for moving documents by drag; omitted on touch devices. */
  dragProps?: DragProps;
}

/** All documents, Unfiled, then the folder hierarchy. Used by the desktop rail and the phone folder sheet. */
export function FolderTree({
  tree,
  activeId,
  counts,
  total,
  onSelect,
  onDelete,
  dragProps = noDrag,
}: FolderTreeProps) {
  return (
    <div className={s.tree}>
      <button
        type="button"
        className={s.node}
        data-active={activeId === 'all'}
        onClick={() => onSelect('all')}
      >
        <Icon icon={FileText} />
        <span className={s.nodeLabel}>All documents</span>
        <span className={s.nodeMeta}>{total}</span>
      </button>
      <button
        type="button"
        className={s.node}
        data-active={activeId === null}
        onClick={() => onSelect(null)}
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
