'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { type DiscoverResult, discover } from '@/lib/ai/discover';
import { indexOwner } from '@/lib/ai/index';
import { createPaperStub, createPdfDocument } from '@/lib/documents';
import { downloadPdf } from '@/lib/ingest';
import { getProjectBySlug } from '@/lib/projects';
import { createSource } from '@/lib/sources';

export async function discoverAction(
  slug: string,
  query: string,
): Promise<DiscoverResult | { error: string }> {
  const project = await getProjectBySlug(slug);
  if (!project) return { error: 'project not found' };
  try {
    return await discover(project.id, query);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface AddCandidateInput {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  url: string;
  arxivId?: string | null;
  doi?: string | null;
  pdfUrl?: string | null;
}

/** Adds a discovered paper: downloads the PDF when there is one, else keeps a metadata record. Non-papers become sources. */
export async function addCandidateAction(
  slug: string,
  c: AddCandidateInput,
  as: 'document' | 'source',
): Promise<{ ok: true; href: string } | { error: string }> {
  const project = await getProjectBySlug(slug);
  if (!project) return { error: 'project not found' };
  if (as === 'source') {
    const src = await createSource(project.id, {
      type: 'web',
      url: c.url,
      title: c.title,
      description: c.abstract.slice(0, 2000),
      tags: [],
    });
    after(() => indexOwner(project.id, 'source', src.id).catch(() => {}));
    revalidatePath(`/p/${slug}/sources`);
    return { ok: true, href: `/p/${slug}/sources` };
  }
  const base = {
    folderId: null,
    sourceUrl: c.url,
    arxivId: c.arxivId ?? null,
    doi: c.doi ?? null,
    meta: { title: c.title, authors: c.authors, year: c.year, abstract: c.abstract },
  };
  let docId: string;
  if (c.pdfUrl && process.env.AI_MOCK !== '1') {
    try {
      const { data, fileName } = await downloadPdf(c.pdfUrl);
      docId = (await createPdfDocument(project.id, { ...base, fileName, data })).id;
    } catch {
      docId = (await createPaperStub(project.id, base)).id;
    }
  } else docId = (await createPaperStub(project.id, base)).id;
  after(() => indexOwner(project.id, 'document', docId).catch(() => {}));
  revalidatePath(`/p/${slug}/documents`);
  return { ok: true, href: `/p/${slug}/documents/${docId}` };
}
