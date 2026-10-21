import { SessionRoute } from '@/components/sessions/session-route';

export const dynamic = 'force-dynamic';

export default async function LecturePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; sessionId: string }>;
  searchParams: Promise<{ doc?: string }>;
}) {
  const { slug, sessionId } = await params;
  const { doc } = await searchParams;
  return <SessionRoute slug={slug} sessionId={sessionId} docId={doc} />;
}
