import { notFound } from 'next/navigation';
import { Explorer } from '@/components/documents/explorer';
import { listDocuments, listFolders } from '@/lib/documents';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ add?: string }>;
}) {
  const { slug } = await params;
  const { add } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const [folders, documents] = await Promise.all([listFolders(project.id), listDocuments(project.id)]);
  return <Explorer slug={slug} folders={folders} documents={documents} openAdd={add === '1'} />;
}
