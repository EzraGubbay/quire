// Background "attach a PDF" for a paper record without a file: twin of attachPdfAction.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { indexOwner } from '@/lib/ai/index';
import { attachPdf } from '@/lib/documents';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import { json, MAX_UPLOAD_BYTES } from '@/lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await ctx.params;
  const project = await getProjectBySlug(slug);
  if (!project) return json({ error: 'Course not found.' }, 404);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'Could not read the upload.' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return json({ error: 'Choose a PDF file.' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: 'PDF is larger than 100 MB.' }, 413);
  try {
    await attachPdf(project.id, docId, new Uint8Array(await file.arrayBuffer()));
    after(() => indexOwner(project.id, 'document', docId).catch(() => {}));
  } catch (err) {
    return json({ error: `Could not read that PDF: ${(err as Error).message}` }, 422);
  }
  revalidatePath(`${projectBase(project)}/documents/${docId}`);
  return json({ id: docId });
}
