import { notFound } from 'next/navigation';
import { SessionsList } from '@/components/sessions/sessions-list';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, requireKind } from '@/lib/projects';
import { listSessions, listSessionsWithDocuments } from '@/lib/sessions';

export const dynamic = 'force-dynamic';

export default async function RecitationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  requireKind(project, 'course');
  const [sessions, allSessions, level] = await Promise.all([
    listSessionsWithDocuments(project.id, 'recitation'),
    listSessions(project.id),
    currentFeature('sessions'),
  ]);
  return (
    <SessionsList
      slug={slug}
      kind="recitation"
      sessions={sessions}
      allSessions={allSessions}
      lite={level.level === 'lite'}
    />
  );
}
