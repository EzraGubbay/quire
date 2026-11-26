// SQL behind drive_inbox_status: which Inbox files are already in a course, by sha256 (Drive's
// sha256Checksum and documents.content_hash are both lowercase hex). Pre-download dedupe for one course
// reuses T2's findDuplicatePdf (../upload-store), not a copy here.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { documents, projects } from '@/db/schema';

export interface HashHit {
  hash: string;
  projectSlug: string;
  projectName: string;
  docId: string;
  title: string;
}

/** Course documents whose content_hash is one of `hashes` (research projects are ignored). */
export async function findDocsByHashes(hashes: string[]): Promise<HashHit[]> {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({
      hash: documents.contentHash,
      projectSlug: projects.slug,
      projectName: projects.name,
      docId: documents.id,
      title: documents.title,
    })
    .from(documents)
    .innerJoin(projects, eq(documents.projectId, projects.id))
    .where(and(eq(projects.kind, 'course'), inArray(documents.contentHash, unique)));
  return rows.flatMap((r) => (r.hash ? [{ ...r, hash: r.hash }] : []));
}
