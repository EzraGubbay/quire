import { and, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { TestView } from '@/components/tests/test-view';
import { db } from '@/db/client';
import { rereadItems } from '@/db/schema';
import { renderMarkdown } from '@/lib/markdown';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { getTest } from '@/lib/tests';

export const dynamic = 'force-dynamic';

export default async function TestPage({ params }: { params: Promise<{ slug: string; testId: string }> }) {
  const { slug, testId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const test = await getTest(project.id, testId);
  if (!test) notFound();
  const [bodies, answers, reread] = await Promise.all([
    Promise.all(test.questions.map(async (q) => [q.id, await renderMarkdown(q.body)] as const)),
    Promise.all(test.questions.map(async (q) => [q.id, await renderMarkdown(q.modelAnswer)] as const)),
    db
      .select()
      .from(rereadItems)
      .where(and(eq(rereadItems.testId, testId))),
  ]);
  const failed = test.questions.some((q) => q.result === 'fail' || q.result === 'partial');
  // The re-read list is produced after marking; while it is empty for a marked test with failures, keep polling.
  const rereadPending =
    test.status === 'marked' &&
    failed &&
    reread.length === 0 &&
    Boolean(test.markedAt) &&
    Date.now() - (test.markedAt?.getTime() ?? 0) < 10 * 60_000;
  return (
    <TestView
      slug={slug}
      test={test}
      questions={test.questions}
      html={Object.fromEntries(bodies)}
      answerHtml={Object.fromEntries(answers)}
      reread={reread}
      rereadPending={rereadPending}
    />
  );
}
