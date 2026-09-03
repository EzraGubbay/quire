import { notFound } from 'next/navigation';
import { DocumentView } from '@/components/documents/document-view';
import { getDocument, getDocumentPages } from '@/lib/documents';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const doc = await getDocument(project.id, docId);
  if (!doc) notFound();
  const pages = doc.kind === 'pdf' ? await getDocumentPages(doc.id) : [];
  return <DocumentView slug={slug} document={doc} pages={pages} />;
}
