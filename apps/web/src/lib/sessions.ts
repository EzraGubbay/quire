import type { SessionKind } from '@quire/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Document, documents, type Session, sessions } from '@/db/schema';

export interface SessionWithDocuments extends Session {
  documents: Document[];
}

export async function listSessions(projectId: string, kind?: SessionKind): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(
      kind
        ? and(eq(sessions.projectId, projectId), eq(sessions.kind, kind))
        : eq(sessions.projectId, projectId),
    )
    .orderBy(asc(sessions.kind), asc(sessions.number), asc(sessions.createdAt));
}

export async function listSessionsWithDocuments(
  projectId: string,
  kind: SessionKind,
): Promise<SessionWithDocuments[]> {
  const rows = await listSessions(projectId, kind);
  if (rows.length === 0) return [];
  const docs = await db
    .select()
    .from(documents)
    .where(
      inArray(
        documents.sessionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(documents.createdAt));
  const byId = new Map<string, Document[]>();
  for (const d of docs) {
    if (!d.sessionId) continue;
    const list = byId.get(d.sessionId) ?? [];
    list.push(d);
    byId.set(d.sessionId, list);
  }
  return rows.map((r) => ({ ...r, documents: byId.get(r.id) ?? [] }));
}

export async function getSession(projectId: string, id: string): Promise<SessionWithDocuments | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.id, id)))
    .limit(1);
  if (!row) return undefined;
  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.sessionId, id))
    .orderBy(asc(documents.createdAt));
  return { ...row, documents: docs };
}

/** The most recent lecture by number, for the overview. */
export async function latestSession(
  projectId: string,
  kind: SessionKind = 'lecture',
): Promise<Session | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, kind)))
    .orderBy(desc(sessions.number), desc(sessions.createdAt))
    .limit(1);
  return row;
}

export async function nextNumber(projectId: string, kind: SessionKind): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${sessions.number})` })
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, kind)));
  return (row?.max ?? 0) + 1;
}

export async function createSession(
  projectId: string,
  input: { kind: SessionKind; number?: number; title: string; date?: string | null },
): Promise<Session> {
  const number = input.number ?? (await nextNumber(projectId, input.kind));
  const [row] = await db
    .insert(sessions)
    .values({ projectId, kind: input.kind, number, title: input.title, date: input.date ?? null })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateSession(
  projectId: string,
  id: string,
  patch: Partial<Pick<Session, 'number' | 'title' | 'date'>>,
): Promise<void> {
  await db
    .update(sessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(sessions.projectId, projectId), eq(sessions.id, id)));
}

/** Deletes the session; its documents stay in the course (session_id becomes null). */
export async function deleteSession(projectId: string, id: string): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.projectId, projectId), eq(sessions.id, id)));
}

export async function attachDocumentToSession(
  projectId: string,
  documentId: string,
  sessionId: string | null,
) {
  await db
    .update(documents)
    .set({ sessionId, updatedAt: new Date() })
    .where(and(eq(documents.projectId, projectId), eq(documents.id, documentId)));
}

export const SESSION_LABEL: Record<SessionKind, { one: string; many: string }> = {
  lecture: { one: 'Lecture', many: 'Lectures' },
  recitation: { one: 'Recitation', many: 'Recitations' },
};

/** "Lecture 2 — SIMD" style display title. */
export const sessionTitle = (s: Pick<Session, 'kind' | 'number' | 'title'>): string =>
  `${SESSION_LABEL[s.kind].one} ${s.number}${s.title ? ` — ${s.title}` : ''}`;

export interface ParsedSessionName {
  kind?: SessionKind;
  number?: number;
  title: string;
}

// `\b` is ASCII-only in JS, so Hebrew words need an explicit "followed by a separator or the end" check.
const END = '(?=[\\s\\d\\-–—:._#]|$)';
const KIND_WORDS: [RegExp, SessionKind][] = [
  [new RegExp(`^(lecture|lec|lect|הרצאה)${END}`, 'i'), 'lecture'],
  [new RegExp(`^(recitation|rec|tutorial|tut|tirgul|exercise|ex|תרגול|תרגיל)${END}`, 'i'), 'recitation'],
];

/**
 * "Lecture 2 - SIMD - A 2027.pptx" → { kind: lecture, number: 2, title: "SIMD" }.
 * Strips the extension, a leading kind word, the number and separators, and a trailing "A 2027"-style term.
 */
export function parseSessionFilename(fileName: string): ParsedSessionName {
  let s = fileName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_]+/g, ' ')
    .trim();
  let kind: SessionKind | undefined;
  for (const [re, k] of KIND_WORDS) {
    if (re.test(s)) {
      kind = k;
      s = s.replace(re, '').trim();
      break;
    }
  }
  let number: number | undefined;
  const m = s.match(/^[\s\-–—:.#]*(\d{1,3})\b/);
  if (m?.[1]) {
    number = Number(m[1]);
    s = s.slice(m[0].length);
  }
  // Trailing semester marker: "- A 2027", "(B 2026)", "Spring 2027", "2027A".
  s = s
    .replace(
      /[\s\-–—(]*(?:[AB]\s*\d{4}|\d{4}\s*[AB]|(?:spring|fall|autumn|winter|summer)\s*\d{4}|סמסטר\s*[אב]?\s*\d{4}?)\)?\s*$/i,
      '',
    )
    .trim();
  s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '').trim();
  return { kind, number, title: s };
}
