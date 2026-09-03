// Embedding index: which entity texts get chunked and embedded, and how they are refreshed.
import type { EntityKind } from '@quire/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { annotations, documentPages, documents, embeddings, notes, sources } from '@/db/schema';
import { chunkText } from './chunk';
import { estimateTokens, recordUsage } from './ledger';
import { aiConfigured, embed } from './provider';
import { getAiSettings } from './settings';

interface OwnerText {
  chunks: { text: string; pageNo?: number }[];
  title: string;
}

async function textsFor(projectId: string, kind: EntityKind, id: string): Promise<OwnerText | null> {
  if (kind === 'document') {
    const [d] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)));
    if (!d) return null;
    const head = [d.title, d.authors.join(', '), d.abstract].filter(Boolean).join('\n');
    const chunks: OwnerText['chunks'] = head ? [{ text: head }] : [];
    if (d.kind === 'markdown') for (const c of chunkText(d.markdownBody ?? '')) chunks.push({ text: c });
    else {
      const pages = await db
        .select()
        .from(documentPages)
        .where(eq(documentPages.documentId, id))
        .orderBy(documentPages.pageNo);
      for (const p of pages) for (const c of chunkText(p.text)) chunks.push({ text: c, pageNo: p.pageNo });
    }
    return { chunks, title: d.title };
  }
  if (kind === 'note') {
    const [n] = await db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.projectId, projectId)));
    if (!n) return null;
    return { chunks: chunkText(`${n.title}\n\n${n.body}`).map((text) => ({ text })), title: n.title };
  }
  if (kind === 'annotation') {
    const [a] = await db
      .select()
      .from(annotations)
      .where(and(eq(annotations.id, id), eq(annotations.projectId, projectId)));
    if (!a || (!a.body && !a.quote)) return null;
    const text = [a.quote ? `“${a.quote}”` : '', a.body].filter(Boolean).join('\n');
    return {
      chunks: [{ text, ...(a.pageNo ? { pageNo: a.pageNo } : {}) }],
      title: a.body.slice(0, 80) || a.quote.slice(0, 80),
    };
  }
  if (kind === 'source') {
    const [x] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.projectId, projectId)));
    if (!x) return null;
    const head = [x.title, x.url ?? '', x.description].filter(Boolean).join('\n');
    return {
      chunks: [{ text: head }, ...chunkText(x.snapshotText ?? '').map((text) => ({ text }))],
      title: x.title,
    };
  }
  return null;
}

/** Re-embeds one entity. Cheap to call after every save; skips silently when AI is not configured. */
export async function indexOwner(projectId: string, kind: EntityKind, id: string): Promise<void> {
  if (!aiConfigured()) return;
  const s = await getAiSettings();
  const owner = await textsFor(projectId, kind, id);
  await db
    .delete(embeddings)
    .where(
      and(eq(embeddings.projectId, projectId), eq(embeddings.ownerKind, kind), eq(embeddings.ownerId, id)),
    );
  if (!owner || owner.chunks.length === 0) return;
  const texts = owner.chunks.map((c) => c.text.slice(0, 8000));
  const est = texts.reduce((n, t) => n + estimateTokens(t), 0);
  let vectors: number[][] = [];
  try {
    const res = await embed(texts, { model: s.models.embeddings, settings: s });
    vectors = res.vectors;
    await recordUsage({
      projectId,
      task: 'embed',
      model: s.models.embeddings,
      usage: res.usage,
      settings: s,
    });
  } catch (err) {
    await recordUsage({
      projectId,
      task: 'embed',
      model: s.models.embeddings,
      usage: { input: est, cached: 0, output: 0 },
      ok: false,
      error: (err as Error).message,
      settings: s,
    });
    throw err;
  }
  await db.insert(embeddings).values(
    owner.chunks.map((c, i) => ({
      projectId,
      ownerKind: kind,
      ownerId: id,
      chunkNo: i,
      pageNo: c.pageNo ?? null,
      text: c.text,
      embedding: vectors[i] ?? [],
      model: s.models.embeddings,
    })),
  );
}

export async function removeOwner(projectId: string, kind: EntityKind, id: string): Promise<void> {
  await db
    .delete(embeddings)
    .where(
      and(eq(embeddings.projectId, projectId), eq(embeddings.ownerKind, kind), eq(embeddings.ownerId, id)),
    );
}

/** Embeds everything in a project that has no chunks yet (or everything, with `force`). */
export async function reindexProject(projectId: string, force = false): Promise<{ indexed: number }> {
  if (!aiConfigured()) return { indexed: 0 };
  const have = force
    ? new Set<string>()
    : new Set(
        (
          await db
            .selectDistinct({ k: embeddings.ownerKind, id: embeddings.ownerId })
            .from(embeddings)
            .where(eq(embeddings.projectId, projectId))
        ).map((r) => `${r.k}:${r.id}`),
      );
  const targets: { kind: EntityKind; id: string }[] = [];
  for (const d of await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.projectId, projectId)))
    targets.push({ kind: 'document', id: d.id });
  for (const n of await db.select({ id: notes.id }).from(notes).where(eq(notes.projectId, projectId)))
    targets.push({ kind: 'note', id: n.id });
  for (const a of await db
    .select({ id: annotations.id })
    .from(annotations)
    .where(eq(annotations.projectId, projectId)))
    targets.push({ kind: 'annotation', id: a.id });
  for (const x of await db.select({ id: sources.id }).from(sources).where(eq(sources.projectId, projectId)))
    targets.push({ kind: 'source', id: x.id });
  let indexed = 0;
  for (const t of targets) {
    if (have.has(`${t.kind}:${t.id}`)) continue;
    await indexOwner(projectId, t.kind, t.id);
    indexed++;
  }
  return { indexed };
}

export interface RetrievedChunk {
  kind: EntityKind;
  id: string;
  chunkNo: number;
  pageNo: number | null;
  text: string;
  score: number;
  title: string;
  href: string;
}

/** Cosine top-k over the project (or one document), with titles and links resolved for citations. */
export async function retrieve(
  projectId: string,
  slug: string,
  query: string,
  opts: { k?: number; documentId?: string | null } = {},
): Promise<RetrievedChunk[]> {
  const s = await getAiSettings();
  const { vectors, usage } = await embed([query.slice(0, 8000)], { model: s.models.embeddings, settings: s });
  await recordUsage({ projectId, task: 'embed-query', model: s.models.embeddings, usage, settings: s });
  const q = vectors[0];
  if (!q) return [];
  const vec = `[${q.join(',')}]`;
  const rows = await db
    .select({
      kind: embeddings.ownerKind,
      id: embeddings.ownerId,
      chunkNo: embeddings.chunkNo,
      pageNo: embeddings.pageNo,
      text: embeddings.text,
      score: sql<number>`1 - (${embeddings.embedding} <=> ${vec}::vector)`,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.projectId, projectId),
        ...(opts.documentId
          ? [eq(embeddings.ownerKind, 'document'), eq(embeddings.ownerId, opts.documentId)]
          : []),
      ),
    )
    .orderBy(sql`${embeddings.embedding} <=> ${vec}::vector`)
    .limit(opts.k ?? 8);
  const byKind = new Map<EntityKind, string[]>();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
  const titles = new Map<string, { title: string; href: string }>();
  const docIds = byKind.get('document') ?? [];
  if (docIds.length)
    for (const d of await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(inArray(documents.id, docIds)))
      titles.set(`document:${d.id}`, { title: d.title, href: `/p/${slug}/documents/${d.id}` });
  const noteIds = byKind.get('note') ?? [];
  if (noteIds.length)
    for (const n of await db
      .select({ id: notes.id, title: notes.title, slug: notes.slug })
      .from(notes)
      .where(inArray(notes.id, noteIds)))
      titles.set(`note:${n.id}`, { title: n.title, href: `/p/${slug}/notes/${n.slug}` });
  const annIds = byKind.get('annotation') ?? [];
  if (annIds.length)
    for (const a of await db
      .select({
        id: annotations.id,
        body: annotations.body,
        quote: annotations.quote,
        documentId: annotations.documentId,
      })
      .from(annotations)
      .where(inArray(annotations.id, annIds)))
      titles.set(`annotation:${a.id}`, {
        title: `Annotation: ${(a.body || a.quote).slice(0, 60)}`,
        href: a.documentId ? `/p/${slug}/documents/${a.documentId}` : `/p/${slug}/documents`,
      });
  const srcIds = byKind.get('source') ?? [];
  if (srcIds.length)
    for (const x of await db
      .select({ id: sources.id, title: sources.title })
      .from(sources)
      .where(inArray(sources.id, srcIds)))
      titles.set(`source:${x.id}`, { title: x.title, href: `/p/${slug}/sources` });
  return rows.map((r) => {
    const t = titles.get(`${r.kind}:${r.id}`) ?? { title: r.kind, href: `/p/${slug}` };
    return { ...r, score: Number(r.score), title: t.title, href: t.href };
  });
}
