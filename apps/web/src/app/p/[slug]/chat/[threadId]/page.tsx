import { notFound } from 'next/navigation';
import s from '@/components/chat/chat.module.css';
import { ChatRail } from '@/components/chat/chat-rail';
import { SpendBanner } from '@/components/chat/spend-banner';
import { ThreadView } from '@/components/chat/thread-view';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { getThread, listMessages, listThreads } from '@/lib/chat';
import { getDocument } from '@/lib/documents';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';
import { ThreadBar } from './thread-bar';

export const dynamic = 'force-dynamic';

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ slug: string; threadId: string }>;
}) {
  const { slug, threadId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const thread = await getThread(project.id, threadId);
  if (!thread) notFound();
  const [threads, messages, summary, scopeDoc, chat] = await Promise.all([
    listThreads(project.id),
    listMessages(threadId),
    spendSummary(),
    thread.documentId ? getDocument(project.id, thread.documentId) : Promise.resolve(undefined),
    currentFeature('chat'),
  ]);
  const phone = chat.platform === 'phone';
  const configured = aiConfigured();
  const disabled = !configured || summary.state === 'capped' || summary.state === 'blocked';
  return (
    <div className={s.layout} data-phone={phone ? 'true' : undefined}>
      {!phone && <ChatRail slug={slug} threads={threads} activeId={threadId} />}
      <div className={s.main}>
        <ThreadBar
          slug={slug}
          thread={thread}
          scopeTitle={scopeDoc?.title ?? null}
          backHref={phone ? `/p/${slug}/chat` : undefined}
        />
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
          <SpendBanner summary={summary} configured={configured} />
          <ThreadView
            slug={slug}
            threadId={threadId}
            initial={messages}
            disabled={disabled}
            scopeTitle={scopeDoc?.title ?? null}
          />
        </div>
        <div />
      </div>
    </div>
  );
}
