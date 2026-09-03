import { notFound } from 'next/navigation';
import { RunView } from '@/components/experiments/run-view';
import { getArtifacts, getLogs, getMetrics, getRun, listObservations } from '@/lib/experiments';
import { renderMarkdown } from '@/lib/markdown';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
}: {
  params: Promise<{ slug: string; expId: string; runId: string }>;
}) {
  const { slug, runId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const found = await getRun(project.id, runId);
  if (!found) notFound();
  const [metrics, logs, artifacts, observations] = await Promise.all([
    getMetrics(runId),
    getLogs(runId),
    getArtifacts(runId),
    listObservations(runId),
  ]);
  const observationHtml = Object.fromEntries(
    await Promise.all(observations.map(async (o) => [o.id, await renderMarkdown(o.body)] as const)),
  );
  return (
    <RunView
      slug={slug}
      experiment={found.experiment}
      run={found.run}
      metrics={metrics}
      logs={logs}
      artifacts={artifacts}
      observations={observations}
      observationHtml={observationHtml}
    />
  );
}
