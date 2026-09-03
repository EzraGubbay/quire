import { notFound } from 'next/navigation';
import { ExperimentsList } from '@/components/experiments/experiments-list';
import { listExperiments } from '@/lib/experiments';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ExperimentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const hint = `pip install quire-client\n\nimport quire\nrun = quire.init(project="${slug}", experiment="my-experiment", params={"lr": 0.1})\nrun.log({"loss": 0.42}, step=1)\nrun.finish()`;
  return <ExperimentsList slug={slug} experiments={await listExperiments(project.id)} apiHint={hint} />;
}
