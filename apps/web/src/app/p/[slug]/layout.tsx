import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { MacroDefs } from '@/components/settings/macro-defs';
import { mergedMacros, newcommandBlock } from '@/lib/macros';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: ReactNode;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const block = newcommandBlock(await mergedMacros(project.id));
  return (
    <AppShell project={{ slug: project.slug, name: project.name }}>
      <MacroDefs block={block} />
      {children}
    </AppShell>
  );
}
