import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { filePath } from '@/lib/files';
import { getProjectBySlug } from '@/lib/projects';
import { getTest } from '@/lib/tests';

export const dynamic = 'force-dynamic';

/** The generated test as a PDF (for paper or an iPad pen app). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; testId: string }> }) {
  const { slug, testId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const t = await getTest(project.id, testId);
  if (!t?.pdfPath) return new Response('No PDF for this test (use the print view)', { status: 404 });
  const abs = filePath(t.pdfPath);
  const info = await stat(abs).catch(() => null);
  if (!info) return new Response('File missing', { status: 404 });
  const disposition = new URL(req.url).searchParams.get('download') ? 'attachment' : 'inline';
  const name = encodeURIComponent(t.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'test');
  return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(info.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${name}.pdf`,
      'cache-control': 'private, max-age=3600',
    },
  });
}
