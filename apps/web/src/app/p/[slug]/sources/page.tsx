import { notFound } from 'next/navigation';
import { SourcesView } from '@/components/sources/sources-view';
import { getProjectBySlug } from '@/lib/projects';
import { listSources } from '@/lib/sources';

export const dynamic = 'force-dynamic';

export default async function SourcesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  return <SourcesView slug={slug} sources={await listSources(project.id)} />;
}
