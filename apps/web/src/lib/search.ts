import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { annotations, documentPages, documents, notes, sources } from '@/db/schema';

export interface SearchHit {
  kind: 'document' | 'note' | 'annotation' | 'source';
  id: string;
  title: string;
  snippet: string;
  href: string;
  meta?: string;
}

/** Substring search across a project's documents (title, authors, abstract, page text), notes, and annotations. */
export async function searchProject(
  projectId: string,
  slug: string,
  query: string,
  limit = 24,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const [docs, pages, ns, anns, srcs] = await Promise.all([
    db
      .select({
        id: documents.id,
        title: documents.title,
        abstract: documents.abstract,
        authors: documents.authors,
        kind: documents.kind,
      })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          or(
            ilike(documents.title, pattern),
            ilike(documents.abstract, pattern),
            sql`array_to_string(${documents.authors}, ' ') ilike ${pattern}`,
          ),
        ),
      )
      .orderBy(desc(documents.updatedAt))
      .limit(limit),
    db
      .select({
        id: documents.id,
        title: documents.title,
        pageNo: documentPages.pageNo,
        text: documentPages.text,
      })
      .from(documentPages)
      .innerJoin(documents, eq(documents.id, documentPages.documentId))
      .where(and(eq(documents.projectId, projectId), ilike(documentPages.text, pattern)))
      .limit(limit),
    db
      .select({ id: notes.id, title: notes.title, slug: notes.slug, body: notes.body })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), or(ilike(notes.title, pattern), ilike(notes.body, pattern))))
      .orderBy(desc(notes.updatedAt))
      .limit(limit),
    db
      .select({
        id: annotations.id,
        body: annotations.body,
        quote: annotations.quote,
        type: annotations.type,
        documentId: annotations.documentId,
        pageNo: annotations.pageNo,
        documentTitle: documents.title,
      })
      .from(annotations)
      .leftJoin(documents, eq(documents.id, annotations.documentId))
      .where(
        and(
          eq(annotations.projectId, projectId),
          or(ilike(annotations.body, pattern), ilike(annotations.quote, pattern)),
        ),
      )
      .orderBy(desc(annotations.updatedAt))
      .limit(limit),
    db
      .select({
        id: sources.id,
        title: sources.title,
        description: sources.description,
        url: sources.url,
        type: sources.type,
      })
      .from(sources)
      .where(
        and(
          eq(sources.projectId, projectId),
          or(
            ilike(sources.title, pattern),
            ilike(sources.description, pattern),
            ilike(sources.snapshotText, pattern),
          ),
        ),
      )
      .orderBy(desc(sources.updatedAt))
      .limit(limit),
  ]);
  const seenDocs = new Set<string>();
  const hits: SearchHit[] = [];
  for (const d of docs) {
    seenDocs.add(d.id);
    hits.push({
      kind: 'document',
      id: d.id,
      title: d.title,
      snippet: excerpt(d.abstract || d.authors.join(', '), q),
      href: `/p/${slug}/documents/${d.id}`,
      meta: d.kind === 'pdf' ? 'PDF' : 'Markdown',
    });
  }
  for (const p of pages) {
    if (seenDocs.has(p.id)) continue;
    seenDocs.add(p.id);
    hits.push({
      kind: 'document',
      id: p.id,
      title: p.title,
      snippet: excerpt(p.text, q),
      href: `/p/${slug}/documents/${p.id}`,
      meta: `p.${p.pageNo}`,
    });
  }
  for (const n of ns)
    hits.push({
      kind: 'note',
      id: n.id,
      title: n.title,
      snippet: excerpt(n.body, q),
      href: `/p/${slug}/notes/${n.slug}`,
      meta: 'Note',
    });
  for (const a of anns) {
    hits.push({
      kind: 'annotation',
      id: a.id,
      title: a.body ? excerpt(a.body, q, 80) : `“${excerpt(a.quote, q, 80)}”`,
      snippet: a.documentTitle ?? '',
      href: a.documentId ? `/p/${slug}/documents/${a.documentId}` : `/p/${slug}/documents`,
      meta: [a.type, a.pageNo ? `p.${a.pageNo}` : null].filter(Boolean).join(' · '),
    });
  }
  for (const x of srcs)
    hits.push({
      kind: 'source',
      id: x.id,
      title: x.title,
      snippet: excerpt(x.description || x.url || '', q),
      href: `/p/${slug}/sources`,
      meta: x.type,
    });
  return hits.slice(0, limit);
}

/** A short window of `text` around the first match of `q`. */
export function excerpt(text: string, q: string, width = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const i = clean.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return clean.slice(0, width) + (clean.length > width ? '…' : '');
  const start = Math.max(0, i - Math.floor(width / 3));
  const end = Math.min(clean.length, start + width);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}
