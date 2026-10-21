import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getDocument } from '@/lib/documents';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  key: 'application/vnd.apple.keynote',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

/** Downloads the uploaded deck (.pptx etc.) that the stored PDF was rendered from. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const doc = await getDocument(project.id, docId);
  if (!doc?.originalPath) return new Response('Not found', { status: 404 });
  const abs = filePath(doc.originalPath);
  const info = await stat(abs).catch(() => null);
  if (!info) return new Response('File missing', { status: 404 });
  const ext = doc.originalPath.split('.').pop()?.toLowerCase() ?? '';
  const name = doc.originalName ?? `${doc.title}.${ext}`;
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, max-age=3600',
    },
  });
}
