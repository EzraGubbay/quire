import { getNote, getNoteBySlug } from '@/lib/notes';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

const safeName = (title: string) =>
  encodeURIComponent(
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'note',
  );

/** The note as a Markdown file (title as heading, body as written, wiki links intact). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return new Response('Not found', { status: 404 });
  const note = (await getNote(project.id, noteId)) ?? (await getNoteBySlug(project.id, noteId));
  if (!note) return new Response('Not found', { status: 404 });
  return new Response(`# ${note.title}\n\n${note.body}`, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${safeName(note.title)}.md`,
      'cache-control': 'private, no-store',
    },
  });
}
