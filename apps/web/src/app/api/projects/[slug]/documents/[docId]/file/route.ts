import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getDocument } from '@/lib/documents';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

const safeName = (title: string) =>
  encodeURIComponent(
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'document',
  );

/** Streams the stored PDF (or the Markdown body) for the viewer; `?download=1` sends it as a file in its original format. */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const doc = await getDocument(project.id, docId);
  if (!doc) return new Response('Not found', { status: 404 });
  const disposition = new URL(req.url).searchParams.get('download') ? 'attachment' : 'inline';
  if (doc.kind === 'markdown') {
    const body = `# ${doc.title}\n\n${doc.markdownBody ?? ''}`;
    return new Response(body, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `${disposition}; filename*=UTF-8''${safeName(doc.title)}.md`,
        'cache-control': 'private, no-store',
      },
    });
  }
  if (!doc.filePath) return new Response('Not found', { status: 404 });
  const abs = filePath(doc.filePath);
  const info = await stat(abs).catch(() => null);
  if (!info) return new Response('File missing', { status: 404 });
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(info.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${safeName(doc.title)}.pdf`,
      'cache-control': 'private, max-age=3600',
    },
  });
}
