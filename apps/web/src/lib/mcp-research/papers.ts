// add_paper: ingest an arXiv id/URL or a DOI into a research project with its metadata. Metadata comes from
// resolveReference (fixed hosts only); the PDF is fetched with the SSRF-guarded fetchPublicPdf, NEVER the
// unguarded downloadPdf. With no fetchable PDF it records a metadata-only paper, as the UI does.
import { createPaperStub } from '@/lib/documents';
import { parseReference, resolveReference } from '@/lib/ingest';
import { FetchRefused, fetchPublicPdf } from '@/lib/mcp/safe-fetch';
import { RESEARCH_SCOPE } from '@/lib/mcp/scope';
import {
  ingestPdf,
  once,
  type ResolvedFolder,
  raceDeadline,
  resolveFolder,
  resolveUploadProject,
  UploadError,
  type UploadResult,
  uploadLimits,
} from '@/lib/mcp/upload';
import { findPaperByRef } from '@/lib/mcp/upload-store';
import { projectBase } from '@/lib/projects';

const PUBLIC_BASE = () =>
  (process.env.QUIRE_PUBLIC_URL ?? 'https://quire.ezragubbay.com').replace(/\/+$/, '');
/** Valid new-style (2401.01234[vN]) and old-style (hep-th/9901001[vN]) arXiv ids. */
const ARXIV_ID_RE = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i;
const baseArxiv = (id: string) => id.replace(/v\d+$/i, '');

export async function addPaper(args: {
  project: string;
  reference: string;
  folder?: string;
}): Promise<UploadResult> {
  const started = Date.now();
  const ref = parseReference(args.reference);
  if (!ref)
    throw new UploadError('Not an arXiv id/URL or DOI. Pass e.g. "2401.01234", an arxiv.org link, or a DOI.');
  if (ref.kind === 'url') {
    throw new UploadError('A plain URL is not accepted by add_paper. For a direct PDF link use upload_pdf.');
  }
  if (ref.kind === 'arxiv' && !ARXIV_ID_RE.test(ref.id)) {
    throw new UploadError(
      `"${ref.id}" is not a valid arXiv id (expected e.g. 2401.01234 or hep-th/9901001).`,
    );
  }
  const project = await resolveUploadProject(args.project, RESEARCH_SCOPE);
  const folder = await resolveFolder(project, 'documents', args.folder);
  let meta: Awaited<ReturnType<typeof resolveReference>>;
  try {
    meta = await resolveReference(ref);
  } catch (err) {
    throw new UploadError(`Could not look that paper up: ${(err as Error).message}`);
  }
  const arxivId = ref.kind === 'arxiv' ? baseArxiv(ref.id) : meta.arxivId ? baseArxiv(meta.arxivId) : null;
  const doi = ref.kind === 'doi' ? ref.doi : (meta.doi ?? null);
  const key = `paper:${project.id}:${arxivId ?? doi!.toLowerCase()}`;
  return once(key, () => run(project, folder, { arxivId, doi, meta }, started));
}

async function run(
  project: Awaited<ReturnType<typeof resolveUploadProject>>,
  folder: ResolvedFolder,
  p: { arxivId: string | null; doi: string | null; meta: Awaited<ReturnType<typeof resolveReference>> },
  started: number,
): Promise<UploadResult> {
  const { arxivId, doi, meta } = p;
  const owner = { project: { slug: project.slug, name: project.name } };
  const existing = await findPaperByRef(project.id, { arxivId, doi });
  if (existing) {
    return {
      status: 'duplicate',
      section: 'documents',
      ...owner,
      fileId: existing.id,
      title: existing.title,
      folder: folder.name,
      pageCount: existing.pageCount,
      openUrl: `${PUBLIC_BASE()}${projectBase(project)}/documents/${existing.id}`,
      next: 'This paper is already in the project; nothing was written.',
    };
  }
  const sourceUrl = meta.sourceUrl ?? (arxivId ? `https://arxiv.org/abs/${arxivId}` : null);
  const paperMeta = { title: meta.title, authors: meta.authors, year: meta.year, abstract: meta.abstract };
  if (meta.pdfUrl) {
    let fetched: Awaited<ReturnType<typeof fetchPublicPdf>> | null = null;
    try {
      fetched = await fetchPublicPdf(meta.pdfUrl);
    } catch (err) {
      // A refused/failed/non-PDF fetch falls back to a metadata-only record; anything else is a real error.
      if (!(err instanceof FetchRefused)) throw err;
    }
    if (fetched) {
      const { data, fileName } = fetched;
      const work = ingestPdf(
        project,
        {
          data,
          fileName,
          title: meta.title?.slice(0, 200),
          folder,
          sourceUrl,
          arxivId,
          doi,
          meta: paperMeta,
        },
        RESEARCH_SCOPE,
      );
      const budget = Math.min(uploadLimits().deadlineMs, Math.max(5_000, 50_000 - (Date.now() - started)));
      const result = await raceDeadline(work, budget);
      return (
        result ?? {
          status: 'processing',
          section: 'documents',
          ...owner,
          title: meta.title ?? arxivId ?? doi ?? 'paper',
          folder: folder.name,
          next: 'Still extracting; it will appear in list_project_files shortly. Calling add_paper again is safe.',
        }
      );
    }
  }
  const stub = await createPaperStub(project.id, {
    folderId: folder.id,
    sourceUrl,
    arxivId,
    doi,
    meta: paperMeta,
  });
  return {
    status: 'created',
    section: 'documents',
    ...owner,
    fileId: stub.id,
    title: stub.title,
    folder: folder.name,
    pageCount: null,
    openUrl: `${PUBLIC_BASE()}${projectBase(project)}/documents/${stub.id}`,
    next: 'Metadata only (hasPdf: false); attach the PDF in Quire or call upload_pdf with a direct PDF link.',
  };
}
