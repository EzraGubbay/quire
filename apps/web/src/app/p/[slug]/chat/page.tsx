import { notFound } from 'next/navigation';
import s from '@/components/chat/chat.module.css';
import { ChatRail } from '@/components/chat/chat-rail';
import { SpendBanner } from '@/components/chat/spend-banner';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { listThreads } from '@/lib/chat';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const [threads, summary] = await Promise.all([listThreads(project.id), spendSummary()]);
  return (
    <div className={s.layout}>
      <ChatRail slug={slug} threads={threads} />
      <div className={s.main}>
        <div className={s.bar}>
          <h1 className={s.title}>Chat</h1>
        </div>
        <div>
          <SpendBanner summary={summary} configured={aiConfigured()} />
          <div className={s.empty}>
            <p>
              Ask questions over this project's documents, notes, annotations, and sources. Pick a chat on the
              left or start a new one.
            </p>
          </div>
        </div>
        <div />
      </div>
    </div>
  );
}
