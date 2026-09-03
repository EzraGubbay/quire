import { notFound } from 'next/navigation';
import { DiscoverView } from '@/components/discover/discover-view';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DiscoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { slug } = await params;
  const { q } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  return (
    <DiscoverView
      slug={slug}
      summary={await spendSummary()}
      configured={aiConfigured()}
      initialQuery={q ?? ''}
    />
  );
}
