import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.env.FILES_DIR ?? './data/files');

/** Absolute path for a stored file. `rel` is what documents.file_path holds. */
export function filePath(rel: string): string {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) throw new Error('path escapes FILES_DIR');
  return abs;
}

export async function storeFile(
  projectId: string,
  documentId: string,
  ext: string,
  data: Uint8Array,
): Promise<string> {
  const rel = path.join(projectId, `${documentId}.${ext}`);
  const abs = filePath(rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return rel;
}

export async function readStoredFile(rel: string): Promise<Buffer> {
  return readFile(filePath(rel));
}

export async function removeStoredFile(rel: string | null): Promise<void> {
  if (!rel) return;
  await rm(filePath(rel), { force: true });
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
