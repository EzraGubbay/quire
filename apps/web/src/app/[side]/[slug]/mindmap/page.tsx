import { notFound } from 'next/navigation';
import { MindMapView } from '@/components/mindmap/mind-map-view';
import { Unavailable } from '@/components/ui/unavailable';
import { listMindMapNodes } from '@/lib/mindmap';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug, projectBase } from '@/lib/projects';
import s from './mindmap-page.module.css';

export const dynamic = 'force-dynamic';

export default async function MindMapPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const base = projectBase(project);
  const { platform, level } = await currentFeature('mindmap');
  if (level === 'off')
    return (
      <Unavailable
        feature="The mind map"
        platform={platform}
        backHref={`${base}/overview`}
        backLabel="Back to overview"
      />
    );
  const nodes = await listMindMapNodes(project.id);
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <h1 className={s.title}>Mind map</h1>
        <p className={s.sub}>Your own mental model — hand-built, separate from the notes graph.</p>
      </div>
      <MindMapView slug={project.slug} initialNodes={nodes} />
    </div>
  );
}
