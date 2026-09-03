import type { AnnotationType, EntityKind } from '@quire/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { annotations, documents, links, notes, sources } from '@/db/schema';

export interface GraphNodeData {
  id: string;
  kind: EntityKind;
  label: string;
  /** Hue: annotation type for idea/insight nodes; the entity's dominant annotation type for documents; 'note' otherwise. */
  hue: AnnotationType;
  href: string;
}
export interface GraphEdgeData {
  from: string;
  to: string;
  kind: 'wiki' | 'belongs' | 'mention' | 'suggested';
}
export interface GraphData {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
}

/** Notes, documents, sources (later), and Idea/Insight annotations, with wiki edges and annotation→document edges. */
export async function getGraph(projectId: string, slug: string): Promise<GraphData> {
  const [ns, ds, ideas, ls, ss] = await Promise.all([
    db
      .select({ id: notes.id, title: notes.title, slug: notes.slug })
      .from(notes)
      .where(eq(notes.projectId, projectId)),
    db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(eq(documents.projectId, projectId)),
    db
      .select({
        id: annotations.id,
        type: annotations.type,
        body: annotations.body,
        quote: annotations.quote,
        documentId: annotations.documentId,
      })
      .from(annotations)
      .where(and(eq(annotations.projectId, projectId), inArray(annotations.type, ['idea', 'insight']))),
    db
      .select({
        fromKind: links.fromKind,
        fromId: links.fromId,
        toKind: links.toKind,
        toId: links.toId,
        kind: links.kind,
      })
      .from(links)
      .where(and(eq(links.projectId, projectId), sql`${links.unresolved} is null`)),
    db.select({ id: sources.id, title: sources.title }).from(sources).where(eq(sources.projectId, projectId)),
    db.select({ id: sources.id, title: sources.title }).from(sources).where(eq(sources.projectId, projectId)),
  ]);
  const docHue = new Map<string, AnnotationType>();
  const hueCounts = await db
    .select({ documentId: annotations.documentId, type: annotations.type, n: sql<number>`count(*)::int` })
    .from(annotations)
    .where(eq(annotations.projectId, projectId))
    .groupBy(annotations.documentId, annotations.type);
  const best = new Map<string, number>();
  for (const r of hueCounts) {
    if (!r.documentId) continue;
    if ((best.get(r.documentId) ?? 0) < r.n) {
      best.set(r.documentId, r.n);
      docHue.set(r.documentId, r.type);
    }
  }
  const nodes: GraphNodeData[] = [
    ...ns.map((n) => ({
      id: n.id,
      kind: 'note' as const,
      label: n.title,
      hue: 'note' as const,
      href: `/p/${slug}/notes/${n.slug}`,
    })),
    ...ds.map((d) => ({
      id: d.id,
      kind: 'document' as const,
      label: d.title,
      hue: docHue.get(d.id) ?? ('note' as const),
      href: `/p/${slug}/documents/${d.id}`,
    })),
    ...ss.map((x) => ({
      id: x.id,
      kind: 'source' as const,
      label: x.title,
      hue: 'note' as const,
      href: `/p/${slug}/sources`,
    })),
    ...ideas.map((a) => ({
      id: a.id,
      kind: 'annotation' as const,
      label: (a.body || a.quote || a.type).slice(0, 60),
      hue: a.type,
      href: a.documentId ? `/p/${slug}/documents/${a.documentId}` : `/p/${slug}/documents`,
    })),
  ];
  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdgeData[] = [
    ...ls
      .filter((l) => known.has(l.fromId) && known.has(l.toId) && l.fromId !== l.toId)
      .map((l) => ({ from: l.fromId, to: l.toId, kind: l.kind })),
    ...ideas
      .filter((a) => a.documentId && known.has(a.documentId))
      .map((a) => ({ from: a.id, to: a.documentId as string, kind: 'belongs' as const })),
  ];
  return { nodes, edges };
}
