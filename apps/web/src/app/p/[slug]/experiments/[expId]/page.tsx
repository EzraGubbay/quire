import { notFound } from 'next/navigation';
import { ExperimentView } from '@/components/experiments/experiment-view';
import { getExperiment, listRuns } from '@/lib/experiments';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ slug: string; expId: string }>;
}) {
  const { slug, expId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const experiment = await getExperiment(project.id, expId);
  if (!experiment) notFound();
  return <ExperimentView slug={slug} experiment={experiment} runs={await listRuns(experiment.id)} />;
}
