import { notFound } from 'next/navigation';
import { DocumentView } from '@/components/documents/document-view';
import { listAnnotations } from '@/lib/annotations';
import { getDocument, getDocumentPages } from '@/lib/documents';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const doc = await getDocument(project.id, docId);
  if (!doc) notFound();
  const [pages, annotations] = await Promise.all([
    doc.kind === 'pdf' ? getDocumentPages(doc.id) : Promise.resolve([]),
    listAnnotations(project.id, doc.id),
  ]);
  return <DocumentView slug={slug} document={doc} pages={pages} annotations={annotations} />;
}
