import { type EntityKind, slugify } from '@quire/shared';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { documents, type Link, links, type Note, notes, sources } from '@/db/schema';
import { extractWikiLinks } from './markdown';

export async function listNotes(projectId: string): Promise<Note[]> {
  return db.select().from(notes).where(eq(notes.projectId, projectId)).orderBy(desc(notes.updatedAt));
}

export async function getNote(projectId: string, id: string): Promise<Note | undefined> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), eq(notes.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export async function getNoteBySlug(projectId: string, slug: string): Promise<Note | undefined> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.slug, slug), eq(notes.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export interface Target {
  kind: EntityKind;
  id: string;
  title: string;
}

/** Resolves a wiki-link name to a note or document in the project, by title (case-insensitive) or note slug. */
export async function resolveTarget(projectId: string, name: string): Promise<Target | undefined> {
  const clean = name.trim();
  if (!clean) return undefined;
  const [note] = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(and(eq(notes.projectId, projectId), or(ilike(notes.title, clean), eq(notes.slug, slugify(clean)))))
    .limit(1);
  if (note) return { kind: 'note', ...note };
  const [doc] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), ilike(documents.title, clean)))
    .limit(1);
  if (doc) return { kind: 'document', ...doc };
  const [src] = await db
    .select({ id: sources.id, title: sources.title })
    .from(sources)
    .where(and(eq(sources.projectId, projectId), ilike(sources.title, clean)))
    .limit(1);
  if (src) return { kind: 'source', ...src };
  return undefined;
}

async function freeSlug(projectId: string, base: string, excludeId?: string): Promise<string> {
  const rows = await db
    .select({ slug: notes.slug, id: notes.id })
    .from(notes)
    .where(and(eq(notes.projectId, projectId), sql`${notes.slug} like ${`${base}%`}`));
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function createNote(projectId: string, title: string, body = ''): Promise<Note> {
  const clean = title.trim() || 'Untitled';
  const slug = await freeSlug(projectId, slugify(clean));
  const [row] = await db.insert(notes).values({ projectId, title: clean, slug, body }).returning();
  if (!row) throw new Error('insert returned no row');
  await syncLinks(projectId, 'note', row.id, body);
  await adoptUnresolved(projectId, row.id, clean);
  return row;
}

export async function updateNote(
  projectId: string,
  id: string,
  patch: { title?: string; body?: string; tags?: string[] },
): Promise<Note | undefined> {
  const current = await getNote(projectId, id);
  if (!current) return undefined;
  const values: Partial<Note> = { updatedAt: new Date() };
  if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== current.title) {
    values.title = patch.title.trim();
    values.slug = await freeSlug(projectId, slugify(values.title), id);
  }
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.tags !== undefined) values.tags = patch.tags;
  const [row] = await db.update(notes).set(values).where(eq(notes.id, id)).returning();
  if (patch.body !== undefined) await syncLinks(projectId, 'note', id, patch.body);
  if (values.title) await adoptUnresolved(projectId, id, values.title);
  return row;
}

export async function deleteNote(projectId: string, id: string): Promise<void> {
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.projectId, projectId)));
  await db
    .delete(links)
    .where(and(eq(links.projectId, projectId), or(eq(links.fromId, id), eq(links.toId, id))));
}

/** Rewrites the wiki-link edges leaving `from` to match the body's [[links]]. Unresolved names are kept as dangling edges. */
export async function syncLinks(
  projectId: string,
  fromKind: EntityKind,
  fromId: string,
  body: string,
): Promise<void> {
  const names = extractWikiLinks(body);
  await db
    .delete(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.fromKind, fromKind),
        eq(links.fromId, fromId),
        eq(links.kind, 'wiki'),
      ),
    );
  if (names.length === 0) return;
  const rows: (typeof links.$inferInsert)[] = [];
  for (const name of names) {
    const target = await resolveTarget(projectId, name);
    if (target && !(target.kind === fromKind && target.id === fromId)) {
      rows.push({ projectId, fromKind, fromId, toKind: target.kind, toId: target.id, kind: 'wiki' });
    } else if (!target) {
      // Dangling: point at the source itself so the row is unique, and keep the name for later adoption.
      rows.push({
        projectId,
        fromKind,
        fromId,
        toKind: fromKind,
        toId: fromId,
        kind: 'wiki',
        unresolved: name,
      });
    }
  }
  if (rows.length > 0) await db.insert(links).values(rows).onConflictDoNothing();
}

/** When a note gains a title, dangling links with that name start pointing at it. */
async function adoptUnresolved(projectId: string, noteId: string, title: string): Promise<void> {
  await db
    .update(links)
    .set({ toKind: 'note', toId: noteId, unresolved: null })
    .where(and(eq(links.projectId, projectId), ilike(links.unresolved, title.trim())));
}

export interface Backlink {
  fromKind: EntityKind;
  fromId: string;
  title: string;
}

export async function backlinksTo(projectId: string, kind: EntityKind, id: string): Promise<Backlink[]> {
  const rows = await db
    .select({ fromKind: links.fromKind, fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.toKind, kind),
        eq(links.toId, id),
        sql`${links.unresolved} is null`,
      ),
    );
  if (rows.length === 0) return [];
  const noteIds = rows.filter((r) => r.fromKind === 'note').map((r) => r.fromId);
  const docIds = rows.filter((r) => r.fromKind === 'document').map((r) => r.fromId);
  const [ns, ds] = await Promise.all([
    noteIds.length
      ? db.select({ id: notes.id, title: notes.title }).from(notes).where(inArray(notes.id, noteIds))
      : [],
    docIds.length
      ? db
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(inArray(documents.id, docIds))
      : [],
  ]);
  const titles = new Map<string, string>([
    ...ns.map((n): [string, string] => [`note:${n.id}`, n.title]),
    ...ds.map((d): [string, string] => [`document:${d.id}`, d.title]),
  ]);
  return rows
    .map((r) => ({ ...r, title: titles.get(`${r.fromKind}:${r.fromId}`) ?? '' }))
    .filter((r) => r.title)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function unresolvedFrom(projectId: string, kind: EntityKind, id: string): Promise<string[]> {
  const rows = await db
    .select({ name: links.unresolved })
    .from(links)
    .where(
      and(
        eq(links.projectId, projectId),
        eq(links.fromKind, kind),
        eq(links.fromId, id),
        sql`${links.unresolved} is not null`,
      ),
    )
    .orderBy(asc(links.unresolved));
  return rows.map((r) => r.name ?? '').filter(Boolean);
}

/** Titles of everything a wiki link can point at, for editor autocomplete. */
export async function linkTargets(projectId: string): Promise<string[]> {
  const [ns, ds, ss] = await Promise.all([
    db.select({ t: notes.title }).from(notes).where(eq(notes.projectId, projectId)),
    db.select({ t: documents.title }).from(documents).where(eq(documents.projectId, projectId)),
    db.select({ t: sources.title }).from(sources).where(eq(sources.projectId, projectId)),
  ]);
  return [...new Set([...ns.map((r) => r.t), ...ds.map((r) => r.t), ...ss.map((r) => r.t)])].sort((a, b) =>
    a.localeCompare(b),
  );
}

export type { Link };
