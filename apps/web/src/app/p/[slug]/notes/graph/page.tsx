import { notFound } from 'next/navigation';
import { GraphView } from '@/components/graph/graph-view';
import { Unavailable } from '@/components/ui/unavailable';
import { getGraph } from '@/lib/graph';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';
import s from './graph-page.module.css';

export const dynamic = 'force-dynamic';

export default async function GraphPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const { platform, level } = await currentFeature('graph');
  if (level === 'off')
    return (
      <Unavailable
        feature="The graph"
        platform={platform}
        backHref={`/p/${slug}/notes`}
        backLabel="Back to notes"
      />
    );
  const data = await getGraph(project.id, slug);
  return (
    <div className={s.wrap}>
      <h1 className={s.title}>Graph</h1>
      <GraphView data={data} width={1100} height={640} />
    </div>
  );
}
