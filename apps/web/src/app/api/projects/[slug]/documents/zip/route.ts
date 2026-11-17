// Streams a ZIP of every document in a course (one best file each — PDF, else the original upload, else the
// markdown body), foldered by the document's folder. Mirrors the streaming shape of the single-file route.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import { listDocuments, listFolders } from '@/lib/documents';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';
import { makeDeduper, safeZipName } from '@/lib/zip-names';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const extOf = (p: string): string => p.split('.').pop()?.toLowerCase() || 'bin';
const onDisk = (abs: string): Promise<boolean> =>
  stat(abs).then(
    () => true,
    () => false,
  );

interface Entry {
  name: string;
  abs?: string;
  body?: string;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });

  const [docs, folders] = await Promise.all([
    listDocuments(project.id),
    listFolders(project.id, 'documents'),
  ]);
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const dedupe = makeDeduper();

  const entries: Entry[] = [];
  for (const d of docs) {
    const dir = d.folderId ? `${safeZipName(folderName.get(d.folderId) ?? 'Folder')}/` : '';
    if (d.filePath) {
      const abs = filePath(d.filePath);
      if (await onDisk(abs)) entries.push({ name: dedupe(`${dir}${safeZipName(d.title)}.pdf`), abs });
    } else if (d.originalPath) {
      const abs = filePath(d.originalPath);
      if (await onDisk(abs)) {
        const base = d.originalName
          ? safeZipName(d.originalName)
          : `${safeZipName(d.title)}.${extOf(d.originalPath)}`;
        entries.push({ name: dedupe(`${dir}${base}`), abs });
      }
    } else if (d.kind === 'markdown') {
      entries.push({
        name: dedupe(`${dir}${safeZipName(d.title)}.md`),
        body: `# ${d.title}\n\n${d.markdownBody ?? ''}`,
      });
    }
  }
  if (entries.length === 0) return new Response('No documents to download', { status: 404 });

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', () => {}); // ENOENT etc. are already filtered above; don't crash the stream.
  // An IO error after the response has started streaming (e.g. a file deleted between the stat check and
  // the read) can't change the status code; abort the truncated download rather than crash the worker.
  archive.on('error', () => archive.destroy());
  for (const e of entries) {
    if (e.abs) archive.append(createReadStream(e.abs), { name: e.name });
    else archive.append(e.body ?? '', { name: e.name });
  }
  void archive.finalize();

  const zipName = `${safeZipName(project.name)}.zip`;
  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'cache-control': 'private, no-store',
    },
  });
}
