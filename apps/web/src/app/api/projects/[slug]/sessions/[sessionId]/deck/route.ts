// Background deck attach for an existing session: the route-handler twin of dropSessionFilesAction's sessionId path.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { indexOwner } from '@/lib/ai/index';
import { createDeckDocument } from '@/lib/documents';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import { attachWarning, getSession } from '@/lib/sessions';
import { json, readUploadFile } from '@/lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; sessionId: string }> }) {
  const { slug, sessionId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return json({ error: 'Course not found.' }, 404);
  const session = await getSession(project.id, sessionId).catch(() => null);
  if (!session) return json({ error: 'Session not found.' }, 404);
  const read = await readUploadFile(req);
  if (read instanceof Response) return read;
  const { file } = read;
  let doc: Awaited<ReturnType<typeof createDeckDocument>>;
  try {
    doc = await createDeckDocument(project.id, {
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      sessionId: session.id,
    });
  } catch (err) {
    return json({ error: `${file.name}: ${(err as Error).message}` }, 422);
  }
  if (doc.filePath) after(() => indexOwner(project.id, 'document', doc.id).catch(() => {}));
  const base = projectBase(project);
  const tab = session.kind === 'lecture' ? 'lectures' : 'recitations';
  revalidatePath(`${base}/${tab}`);
  revalidatePath(`${base}/${tab}/${session.id}`);
  revalidatePath(`${base}/documents`);
  const warning = attachWarning(session, file.name);
  return json(warning ? { id: doc.id, warning } : { id: doc.id });
}
