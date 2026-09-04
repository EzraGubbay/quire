import { notFound, redirect } from 'next/navigation';
import { DocumentEditor } from '@/components/documents/document-editor';
import { Unavailable } from '@/components/ui/unavailable';
import { getDocument, listDocuments } from '@/lib/documents';
import { mergedMacros } from '@/lib/macros';
import { currentFeature } from '@/lib/platform-server';
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
  const { platform, level } = await currentFeature('documents.edit');
  if (level === 'off')
    return (
      <Unavailable
        feature="The document editor"
        platform={platform}
        backHref={`/p/${slug}/documents/${docId}`}
        backLabel="Back to the document"
      />
    );
  const [docs, macroRows] = await Promise.all([listDocuments(project.id), mergedMacros(project.id)]);
  const targets = docs.filter((d) => d.id !== doc.id).map((d) => d.title);
  return (
    <DocumentEditor slug={slug} document={doc} linkTargets={targets} macros={macroRows.map((m) => m.name)} />
  );
}
