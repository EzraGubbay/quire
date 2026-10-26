// The agent posts one downloaded file here (multipart). Quire hashes, dedupes, classifies and places it.
import { apiError, json, projectFromSlug } from '@/lib/api';
import { type ImportMeta, importLemidaFile } from '@/lib/lemida/import';
import { saveLemidaState } from '@/lib/lemida/state';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 200 * 1024 * 1024;

const str = (v: FormDataEntryValue | null): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const project = await projectFromSlug(slug);
  if (!project) return apiError('project not found', 404);
  if (project.kind !== 'course') return apiError('not a course', 400);
  await saveLemidaState({ agentSeenAt: new Date().toISOString() });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return apiError('file is required');
  if (file.size > MAX_BYTES) return apiError('file is larger than 200 MB', 413);
  const data = new Uint8Array(await file.arrayBuffer());

  const meta: ImportMeta = {
    fileName: str(form.get('fileName')) ?? file.name ?? 'file',
    sourceUrl: str(form.get('sourceUrl')),
    sectionTitle: str(form.get('sectionTitle')),
    moduleType: str(form.get('moduleType')),
    contentType: file.type || str(form.get('contentType')),
    firstPageSnippet: str(form.get('firstPageSnippet')),
    mappingId: str(form.get('mappingId')) ?? null,
  };

  const result = await importLemidaFile(project, meta, data);
  return json(result, 201);
}
