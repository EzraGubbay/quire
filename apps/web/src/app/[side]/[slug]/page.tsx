import { redirect } from 'next/navigation';

export default async function ProjectIndex({ params }: { params: Promise<{ side: string; slug: string }> }) {
  const { side, slug } = await params;
  redirect(`/${side}/${slug}/overview`);
}
