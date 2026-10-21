import { notFound } from 'next/navigation';
import { AssignmentView } from '@/components/homework/assignment-view';
import { getAssignment } from '@/lib/homework';
import { getProjectBySlug, requireKind } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function AssignmentPage({
  params,
}: {
  params: Promise<{ slug: string; assignmentId: string }>;
}) {
  const { slug, assignmentId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const assignment = await getAssignment(project.id, assignmentId);
  if (!assignment) notFound();
  return <AssignmentView slug={slug} assignment={assignment} />;
}
