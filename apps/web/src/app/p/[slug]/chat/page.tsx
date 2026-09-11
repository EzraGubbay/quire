import { notFound } from 'next/navigation';
import s from '@/components/chat/chat.module.css';
import { ChatRail } from '@/components/chat/chat-rail';
import { SpendBanner } from '@/components/chat/spend-banner';
import { spendSummary } from '@/lib/ai/ledger';
import { aiConfigured } from '@/lib/ai/provider';
import { listThreads } from '@/lib/chat';
import { getDocument } from '@/lib/documents';
import { currentFeature } from '@/lib/platform-server';
import { getProjectBySlug } from '@/lib/projects';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ doc?: string }>;
}) {
  const { slug } = await params;
  const { doc } = await searchParams;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  const scopeDoc = doc ? await getDocument(project.id, doc) : undefined;
  const scope = scopeDoc ? { documentId: scopeDoc.id, title: scopeDoc.title } : null;
  const [threads, summary, chat] = await Promise.all([
    listThreads(project.id, scope?.documentId ?? null),
    spendSummary(),
    currentFeature('chat'),
  ]);
  // Phones: the list is the page; a thread opens on its own route.
  if (chat.platform === 'phone')
    return (
      <div className={s.layout} data-phone="true">
        <ChatRail slug={slug} threads={threads} phone scope={scope} />
      </div>
    );
  return (
    <div className={s.layout}>
      <ChatRail slug={slug} threads={threads} scope={scope} />
      <div className={s.main}>
        <div className={s.bar}>
          <h1 className={s.title}>{scope ? `Chats about “${scope.title}”` : 'Chat'}</h1>
        </div>
        <div>
          <SpendBanner summary={summary} configured={aiConfigured()} />
          <div className={s.empty}>
            <p>
              {scope
                ? `These chats assume you are asking about “${scope.title}”. Pick one on the left or start a new one.`
                : "Ask questions over this project's documents, notes, annotations, and sources. Pick a chat on the left or start a new one. Name a document with doc. or [[ to point the answer at it."}
            </p>
          </div>
        </div>
        <div />
      </div>
    </div>
  );
}
