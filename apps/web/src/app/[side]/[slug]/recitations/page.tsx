import { notFound } from 'next/navigation';
import { SessionsList } from '@/components/sessions/sessions-list';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { listSessionsWithDocuments } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

export default async function RecitationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const [sessions, level] = await Promise.all([
    listSessionsWithDocuments(project.id, 'recitation'),
    currentFeature('sessions'),
  ]);
  return <SessionsList slug={slug} kind="recitation" sessions={sessions} lite={level.level === 'lite'} />;
}
