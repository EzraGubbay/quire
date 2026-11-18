// Background document upload: same server work as uploadPdfAction, but returns JSON so the client can use XHR
// progress and keep the upload running across in-app navigation.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { indexOwner } from '@/lib/ai/index';
import { createDeckDocument } from '@/lib/documents';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import { json, readUploadFile } from '@/lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return json({ error: 'Course not found.' }, 404);
  const read = await readUploadFile(req);
  if (read instanceof Response) return read;
  const { file, form } = read;
  const rawFolder = String(form.get('folderId') ?? '');
  const title = String(form.get('title') ?? '').trim();
  let doc: Awaited<ReturnType<typeof createDeckDocument>>;
  try {
    doc = await createDeckDocument(project.id, {
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      folderId: UUID.test(rawFolder) ? rawFolder : null,
      title: title || undefined,
    });
  } catch (err) {
    return json({ error: `Could not read ${file.name}: ${(err as Error).message}` }, 422);
  }
  if (doc.filePath) after(() => indexOwner(project.id, 'document', doc.id).catch(() => {}));
  revalidatePath(`${projectBase(project)}/documents`);
  return json({ id: doc.id });
}
