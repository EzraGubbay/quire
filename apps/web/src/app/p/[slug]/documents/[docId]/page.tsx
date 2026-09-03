import { notFound } from 'next/navigation';
import { DocumentView } from '@/components/documents/document-view';
import { listAnnotations } from '@/lib/annotations';
import { getDocument } from '@/lib/documents';
import { renderMarkdown } from '@/lib/markdown';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ slug: string; docId: string }> }) {
  const { slug, docId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const doc = await getDocument(project.id, docId);
  if (!doc) notFound();
  const [annotations, html] = await Promise.all([
    listAnnotations(project.id, doc.id),
    doc.kind === 'markdown' ? renderMarkdown(doc.markdownBody ?? '') : Promise.resolve(''),
  ]);
  return <DocumentView slug={slug} document={doc} annotations={annotations} html={html} />;
}
