// The small SQL helpers behind the MCP write tools' idempotency checks. Split from upload.ts so the pure
// orchestration there unit-tests with these mocked, while upload.db.integration.test.ts runs them for real.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Document, documents, type Note, notes } from '@/db/schema';
import { readStoredFile, sha256 } from '@/lib/files';

/**
 * An existing PDF document in the project with the same source bytes. Matches on `content_hash`; rows that
 * predate hashing (NULL) are only read from disk when their size matches, and get their hash backfilled
 * (same semantics as the Lemida importer's lazy backfill, which this deliberately does not touch).
 */
export async function findDuplicatePdf(
  projectId: string,
  hash: string,
  size: number,
): Promise<Document | undefined> {
  const [hit] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.contentHash, hash)))
    .limit(1);
  if (hit) return hit;
  const unhashed = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        isNull(documents.contentHash),
        eq(documents.fileSize, size),
        eq(documents.kind, 'pdf'),
      ),
    );
  for (const doc of unhashed) {
    const rel = doc.originalPath ?? doc.filePath;
    if (!rel) continue;
    let bytes: Buffer;
    try {
      bytes = await readStoredFile(rel);
    } catch {
      continue;
    }
    const h = sha256(bytes);
    await setContentHash(doc.id, h);
    if (h === hash) return { ...doc, contentHash: h };
  }
  return undefined;
}

export async function setContentHash(documentId: string, hash: string): Promise<void> {
  await db.update(documents).set({ contentHash: hash }).where(eq(documents.id, documentId));
}

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
