import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type MindMapNode, mindMapNodes } from '@/db/schema';

export type { MindMapNode } from '@/db/schema';

/** Every node of a project's mind map, in a stable order (siblings by sort_order, then creation). */
export async function listMindMapNodes(projectId: string): Promise<MindMapNode[]> {
  return db
    .select()
    .from(mindMapNodes)
    .where(eq(mindMapNodes.projectId, projectId))
    .orderBy(asc(mindMapNodes.sortOrder), asc(mindMapNodes.createdAt));
}

/** The next sort_order for a new child of `parentId` (or for a new root when null). */
async function nextSortOrder(projectId: string, parentId: string | null): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${mindMapNodes.sortOrder})` })
    .from(mindMapNodes)
    .where(
      and(
        eq(mindMapNodes.projectId, projectId),
        parentId ? eq(mindMapNodes.parentId, parentId) : isNull(mindMapNodes.parentId),
      ),
    );
  return (row?.max ?? -1) + 1;
}

export async function createMindMapNode(
  projectId: string,
  opts: { parentId?: string | null; label?: string; x?: number | null; y?: number | null } = {},
): Promise<MindMapNode> {
  const parentId = opts.parentId ?? null;
  if (parentId) await assertNodeInProject(projectId, parentId);
  const sortOrder = await nextSortOrder(projectId, parentId);
  const [row] = await db
    .insert(mindMapNodes)
    .values({
      projectId,
      parentId,
      label: opts.label?.trim() || 'New node',
      x: opts.x ?? null,
      y: opts.y ?? null,
      sortOrder,
    })
    .returning();
  if (!row) throw new Error('could not create node');
  return row;
}

type NodePatch = Partial<Pick<MindMapNode, 'label' | 'note' | 'x' | 'y' | 'collapsed' | 'sortOrder'>>;

/** Patch a node's own fields (label, note, position, collapse, order). Scoped to the project. */
export async function updateMindMapNode(
  projectId: string,
  id: string,
  patch: NodePatch,
): Promise<MindMapNode | undefined> {
  const [row] = await db
    .update(mindMapNodes)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(mindMapNodes.id, id), eq(mindMapNodes.projectId, projectId)))
    .returning();
  return row;
}

/** Delete a node; the DB cascades to its whole subtree. */
export async function deleteMindMapNode(projectId: string, id: string): Promise<void> {
  await db.delete(mindMapNodes).where(and(eq(mindMapNodes.id, id), eq(mindMapNodes.projectId, projectId)));
}

async function assertNodeInProject(projectId: string, id: string): Promise<MindMapNode> {
  const [row] = await db
    .select()
    .from(mindMapNodes)
    .where(and(eq(mindMapNodes.id, id), eq(mindMapNodes.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error('node not found');
  return row;
}

/** Ids of `id` and every node beneath it, so a reparent can't create a cycle. */
function descendantsOf(id: string, all: MindMapNode[]): Set<string> {
  const childrenBy = new Map<string | null, string[]>();
  for (const n of all) {
    const arr = childrenBy.get(n.parentId) ?? [];
    arr.push(n.id);
    childrenBy.set(n.parentId, arr);
  }
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const child of childrenBy.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/**
 * Move a node under a new parent (null → promote to a root). Rejects a move that would form a cycle
 * (onto itself or one of its own descendants) and appends it to the new parent's siblings.
 */
export async function reparentMindMapNode(
  projectId: string,
  id: string,
  parentId: string | null,
): Promise<MindMapNode | undefined> {
  await assertNodeInProject(projectId, id);
  if (parentId) {
    if (parentId === id) throw new Error('a node cannot be its own parent');
    await assertNodeInProject(projectId, parentId);
    const all = await listMindMapNodes(projectId);
    if (descendantsOf(id, all).has(parentId)) throw new Error('cannot move a node under its own descendant');
  }
  const sortOrder = await nextSortOrder(projectId, parentId);
  const [row] = await db
    .update(mindMapNodes)
    .set({ parentId, sortOrder, updatedAt: new Date() })
    .where(and(eq(mindMapNodes.id, id), eq(mindMapNodes.projectId, projectId)))
    .returning();
  return row;
}
