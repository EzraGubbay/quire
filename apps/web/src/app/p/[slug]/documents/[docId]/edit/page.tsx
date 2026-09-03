import { notFound, redirect } from 'next/navigation';
import { DocumentEditor } from '@/components/documents/document-editor';
import { getDocument, listDocuments } from '@/lib/documents';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ slug: string; docId: string }>;
}) {
  const { slug, docId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const doc = await getDocument(project.id, docId);
  if (!doc) notFound();
  if (doc.kind !== 'markdown') redirect(`/p/${slug}/documents/${docId}`);
  const targets = (await listDocuments(project.id)).filter((d) => d.id !== doc.id).map((d) => d.title);
  return <DocumentEditor slug={slug} document={doc} linkTargets={targets} />;
}
