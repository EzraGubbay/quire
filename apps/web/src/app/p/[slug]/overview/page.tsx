import { Card } from '@ezragubbay/folio';
import { notFound } from 'next/navigation';
import { getProjectBySlug } from '@/lib/projects';
import s from './overview.module.css';

export default async function OverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const started = project.createdAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>{project.name}</h1>
        <p className={s.meta}>Started {started}</p>
        {project.description && <p className={s.desc}>{project.description}</p>}
      </header>
      <div className={s.grid}>
        <Card title="Recent documents" action={<span />}>
          <p className={s.muted}>Documents arrive next: PDFs, arXiv, DOI, and your own Markdown.</p>
        </Card>
        <Card title="Open questions" action={<span />}>
          <p className={s.muted}>Question and Todo annotations will show up here.</p>
        </Card>
        <Card title="Experiments" action={<span />}>
          <p className={s.muted}>Runs reported by the Python client.</p>
        </Card>
        <Card title="Note graph" action={<span />}>
          <p className={s.muted}>Notes, documents, sources, and ideas, linked.</p>
        </Card>
      </div>
    </div>
  );
}
