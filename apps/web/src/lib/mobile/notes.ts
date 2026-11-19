// Mappers from the notes table to the mobile v1 Note / NoteSummary wire shapes (read-only).
import type { Note as NoteRow } from '@/db/schema';
import type { Note, NoteSummary } from './schema';

export interface NoteContext {
  folder?: string;
  session?: NoteSummary['session'];
}

export function toNoteSummary(row: NoteRow, ctx: NoteContext = {}): NoteSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    ...(ctx.folder ? { folder: ctx.folder } : {}),
    ...(ctx.session ? { session: ctx.session } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Raw Markdown is passed through verbatim: wiki-links and LaTeX stay intact. */
export function toNote(row: NoteRow, ctx: NoteContext = {}): Note {
  return { ...toNoteSummary(row, ctx), markdown: row.body };
}
