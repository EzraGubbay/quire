import { getProjectBySlug } from '@/lib/projects';
import { getSource } from '@/lib/sources';

export const dynamic = 'force-dynamic';

const safeName = (title: string) =>
  encodeURIComponent(
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'source',
  );

/** A source has no file of its own; the download is a Markdown record: title, type, link, tags, description, snapshot. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; sourceId: string }> }) {
  const { slug, sourceId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const src = await getSource(project.id, sourceId);
  if (!src) return new Response('Not found', { status: 404 });
  const lines = [
    `# ${src.title}`,
    '',
    `- Type: ${src.type}`,
    ...(src.url ? [`- Link: ${src.url}`] : []),
    ...(src.tags.length ? [`- Tags: ${src.tags.map((t) => `#${t}`).join(' ')}`] : []),
    ...(src.description ? ['', src.description] : []),
    ...(src.snapshotText ? ['', '---', '', '## Captured text', '', src.snapshotText] : []),
    '',
  ];
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${safeName(src.title)}.md`,
      'cache-control': 'private, no-store',
    },
  });
}
