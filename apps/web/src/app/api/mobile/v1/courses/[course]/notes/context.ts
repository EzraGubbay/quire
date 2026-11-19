import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { folders, type Note, sessions } from '@/db/schema';
import type { NoteContext } from '@/lib/mobile/notes';

/** Resolves folder names and session kind/number for a set of notes of one project. */
export async function noteContexts(projectId: string, rows: Note[]): Promise<Map<string, NoteContext>> {
  const [fs, ss] = await Promise.all([
    rows.some((n) => n.folderId)
      ? db
          .select({ id: folders.id, name: folders.name })
          .from(folders)
          .where(eq(folders.projectId, projectId))
      : [],
    rows.some((n) => n.sessionId)
      ? db
          .select({ id: sessions.id, kind: sessions.kind, number: sessions.number })
          .from(sessions)
          .where(eq(sessions.projectId, projectId))
      : [],
  ]);
  const fm = new Map(fs.map((f) => [f.id, f.name]));
  const sm = new Map(ss.map((s) => [s.id, { kind: s.kind, number: s.number }]));
  return new Map(
    rows.map((n) => [
      n.id,
      {
        folder: n.folderId ? fm.get(n.folderId) : undefined,
        session: n.sessionId ? sm.get(n.sessionId) : undefined,
      },
    ]),
  );
}
