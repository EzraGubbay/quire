// The small SQL helpers behind the MCP write tools' idempotency checks. Split from upload.ts so the pure
// orchestration there unit-tests with these mocked, while upload.db.integration.test.ts runs them for real.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Document, documents, type Note, notes } from '@/db/schema';

/** A note with this title (case-insensitive: wiki links resolve that way). */
export async function findNoteByTitle(projectId: string, title: string): Promise<Note | undefined> {
  const [row] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.projectId, projectId), sql`lower(${notes.title}) = lower(${title})`))
    .limit(1);
  return row;
}

/** A Markdown document with exactly this title and body. */
export async function findMarkdownDoc(
  projectId: string,
  title: string,
  body: string,
): Promise<Document | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        eq(documents.kind, 'markdown'),
        eq(documents.title, title),
        eq(documents.markdownBody, body),
      ),
    )
    .limit(1);
  return row;
}
