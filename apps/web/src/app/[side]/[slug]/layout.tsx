import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { ProjectProvider } from '@/components/project-context';
import { MacroDefs } from '@/components/settings/macro-defs';
import { mergedMacros, newcommandBlock } from '@/lib/macros';
import { getProjectBySlug, projectBase, sideFor } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/** Research projects are served under /p/<slug>, courses under /c/<slug>; the other prefix redirects. */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ side: string; slug: string }>;
  children: ReactNode;
}) {
  const { side, slug } = await params;
  if (side !== 'p' && side !== 'c') notFound();
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  if (side !== sideFor(project.kind)) redirect(`${projectBase(project)}/overview`);
  const block = newcommandBlock(await mergedMacros(project.id));
  const info = {
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
    base: projectBase(project),
  };
  return (
    <ProjectProvider value={info}>
      <AppShell project={info}>
        <MacroDefs block={block} />
        {children}
      </AppShell>
    </ProjectProvider>
  );
}
