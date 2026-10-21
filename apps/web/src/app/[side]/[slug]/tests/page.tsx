import { notFound } from 'next/navigation';
import { TestsList } from '@/components/tests/tests-list';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { listSessions } from '@/lib/sessions';
import { listTests, practiceExamCount, weeksSinceLastTriweekly } from '@/lib/tests';

export const dynamic = 'force-dynamic';

export default async function TestsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const [tests, sessions, exams, weeks, gen] = await Promise.all([
    listTests(project.id),
    listSessions(project.id),
    practiceExamCount(project.id),
    weeksSinceLastTriweekly(project.id),
    currentFeature('tests.generate'),
  ]);
  return (
    <TestsList
      slug={slug}
      tests={tests}
      sessions={sessions}
      practiceExams={exams}
      weeksSinceTriweekly={weeks}
      canGenerate={gen.level !== 'off'}
    />
  );
}
