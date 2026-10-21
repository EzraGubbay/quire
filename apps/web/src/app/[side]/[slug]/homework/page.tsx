import { notFound } from 'next/navigation';
import { HomeworkList } from '@/components/homework/homework-list';
import { listAssignmentsWithProgress } from '@/lib/homework';
import { getProjectBySlug, requireKind } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function HomeworkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const assignments = await listAssignmentsWithProgress(project.id);
  return <HomeworkList slug={slug} assignments={assignments} />;
}
