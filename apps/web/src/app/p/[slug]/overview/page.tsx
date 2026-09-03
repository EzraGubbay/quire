import { Card, CardRow, HighlightChip, Icon } from '@ezragubbay/folio';
import { ANNOTATION_TYPE_LABEL } from '@quire/shared';
import { FileText, FolderOpen } from 'lucide-react';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { GraphView } from '@/components/graph/graph-view';
import { getGraph } from '@/lib/graph';
import { getOverview } from '@/lib/overview';
import { getProjectBySlug } from '@/lib/projects';
import s from './overview.module.css';

export const dynamic = 'force-dynamic';

const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const ago = (d: Date) => {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return fmt(d);
};

export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const [o, graph] = await Promise.all([getOverview(project.id), getGraph(project.id, slug)]);
  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>{project.name}</h1>
        <p className={s.meta}>
          Started {fmt(project.createdAt)}
          {o.lastActivity ? ` · last activity ${ago(o.lastActivity)}` : ''}
        </p>
        {project.description && <p className={s.desc}>{project.description}</p>}
        <dl className={s.stats}>
          <div>
            <dt>Documents</dt>
            <dd>{o.counts.documents}</dd>
          </div>
          <div>
            <dt>Annotations</dt>
            <dd>{o.counts.annotations}</dd>
          </div>
          <div>
            <dt>Open questions</dt>
            <dd>{o.counts.open}</dd>
          </div>
        </dl>
      </header>
      <div className={s.grid}>
        <Card
          title="Recent documents"
          action={
            <NextLink href={`/p/${slug}/documents`} className={s.more}>
              All
            </NextLink>
          }
        >
          {o.recentDocuments.length === 0 ? (
            <p className={s.muted}>
              Nothing yet. Add a PDF, paste an arXiv id, or start a Markdown document.
            </p>
          ) : (
            o.recentDocuments.map((d) => (
              <CardRow
                key={d.id}
                icon={<Icon icon={d.kind === 'pdf' ? FileText : FolderOpen} />}
                title={<NextLink href={`/p/${slug}/documents/${d.id}`}>{d.title}</NextLink>}
                meta={[
                  d.readingStatus,
                  d.kind === 'pdf' && d.pageCount ? `${d.pageCount} pages` : null,
                  d.year ? String(d.year) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))
          )}
        </Card>
        <Card title="Open questions" action={<span className={s.more}>{o.counts.open}</span>}>
          {o.openItems.length === 0 ? (
            <p className={s.muted}>Question and Todo annotations will show up here.</p>
          ) : (
            o.openItems.map((a) => (
              <CardRow
                key={a.id}
                title={
                  a.documentId ? (
                    <NextLink href={`/p/${slug}/documents/${a.documentId}`}>
                      {a.body || a.quote || ANNOTATION_TYPE_LABEL[a.type]}
                    </NextLink>
                  ) : (
                    a.body || ANNOTATION_TYPE_LABEL[a.type]
                  )
                }
                meta={[a.documentTitle, a.pageNo ? `p.${a.pageNo}` : null].filter(Boolean).join(' · ')}
                trailing={<HighlightChip kind={a.type === 'question' ? 'question' : 'todo'} />}
              />
            ))
          )}
        </Card>
        <Card title="Experiments" action={<span />}>
          <p className={s.muted}>Runs reported by the Python client arrive in Phase 3.</p>
        </Card>
        <Card
          title="Note graph"
          action={
            <NextLink href={`/p/${slug}/notes/graph`} className={s.more}>
              Open
            </NextLink>
          }
          className={s.wide}
        >
          <GraphView data={graph} width={640} height={320} legend={false} />
        </Card>
      </div>
    </div>
  );
}
