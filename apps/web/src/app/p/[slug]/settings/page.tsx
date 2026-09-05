import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { MacrosPanel } from '@/components/settings/macros-panel';
import { ReindexPanel } from '@/components/settings/reindex-panel';
import s from '@/components/settings/settings.module.css';
import { listMacros } from '@/lib/macros';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const [own, global, full] = await Promise.all([
    listMacros(project.id),
    listMacros(null),
    currentFeature('settings.full'),
  ]);
  const lite = full.level === 'lite';
  return (
    <div className={s.wrap}>
      <NextLink href={`/p/${slug}/overview`} className={s.crumb}>
        ← {project.name}
      </NextLink>
      <h1 className={s.title}>{project.name} · settings</h1>
      {!lite && (
        <MacrosPanel
          scope="project"
          slug={slug}
          macros={own}
          inherited={global.filter((g) => !own.some((o) => o.name === g.name))}
        />
      )}
      <ReindexPanel slug={slug} />
      {lite && <p className={s.help}>Project macros are edited on an iPad or laptop.</p>}
    </div>
  );
}
