import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getDocument } from '@/lib/documents';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/** Streams the stored PDF for the in-app viewer. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const doc = await getDocument(project.id, docId);
  if (!doc?.filePath) return new Response('Not found', { status: 404 });
  const abs = filePath(doc.filePath);
  const info = await stat(abs).catch(() => null);
  if (!info) return new Response('File missing', { status: 404 });
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(info.size),
      'content-disposition': `inline; filename="${encodeURIComponent(doc.title.slice(0, 80))}.pdf"`,
      'cache-control': 'private, max-age=3600',
    },
  });
}
