import { notFound } from 'next/navigation';
import { DocumentView } from '@/components/documents/document-view';
import { listAnnotations } from '@/lib/annotations';
import { getDocument, listPracticeExams } from '@/lib/documents';
import { renderMarkdown } from '@/lib/markdown';
import { linkTargets } from '@/lib/notes';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; docId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug, docId } = await params;
  const { page } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const doc = await getDocument(project.id, docId);
  if (!doc) notFound();
  const [annotations, html, targets, exams] = await Promise.all([
    listAnnotations(project.id, doc.id),
    doc.kind === 'markdown' ? renderMarkdown(doc.markdownBody ?? '') : Promise.resolve(''),
    linkTargets(project.id),
    project.kind === 'course'
      ? listPracticeExams(project.id)
      : Promise.resolve({ exams: [], folderId: null }),
  ]);
  const [viewer, annotate] = await Promise.all([
    currentFeature('documents.viewer'),
    currentFeature('documents.annotate'),
  ]);
  const initialPage = page && /^\d+$/.test(page) ? Number(page) : undefined;
  const inExams = exams.folderId !== null && doc.folderId === exams.folderId;
  return (
    <DocumentView
      slug={slug}
      document={doc}
      annotations={annotations}
      html={html}
      linkTargets={targets}
      canAnnotate={annotate.level !== 'off'}
      lite={viewer.level === 'lite'}
      platform={viewer.platform}
      initialPage={initialPage}
      practiceExam={
        inExams
          ? {
              candidates: exams.exams
                .filter((e) => e.id !== doc.id)
                .map((e) => ({ id: e.id, title: e.title })),
            }
          : undefined
      }
    />
  );
}
