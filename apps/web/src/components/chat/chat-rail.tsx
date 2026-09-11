'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useTransition } from 'react';
import { newThreadAndGoAction } from '@/app/actions/chat';
import type { ChatThread } from '@/db/schema';
import s from './chat.module.css';

export function ChatRail({
  slug,
  threads,
  activeId,
  phone = false,
  scope,
}: {
  slug: string;
  threads: ChatThread[];
  activeId?: string;
  /** Full-page list on phones. */
  phone?: boolean;
  /** Only this document's chats are listed and new chats are scoped to it. */
  scope?: { documentId: string; title: string } | null;
}) {
  const [pending, start] = useTransition();
  return (
    <aside className={s.rail} aria-label="Chats" data-phone={phone ? 'true' : undefined}>
      <div className={s.railHead}>
        <h2 className={s.railTitle} title={scope ? `Chats about ${scope.title}` : undefined}>
          {scope ? `About “${scope.title}” · ${threads.length}` : `Chats · ${threads.length}`}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New chat"
          icon={<Icon icon={Plus} />}
          disabled={pending}
          onClick={() => start(() => newThreadAndGoAction(slug, scope?.documentId ?? null))}
        />
      </div>
      {scope && (
        <div className={s.railScope}>
          <NextLink href={`/p/${slug}/documents/${scope.documentId}`}>Open document</NextLink>
          <NextLink href={`/p/${slug}/chat`}>All chats</NextLink>
        </div>
      )}
      <div className={s.list}>
        {threads.length === 0 ? (
          <p className={s.itemMeta} style={{ padding: 10 }}>
            {scope ? 'No chats about this document yet.' : 'No chats yet.'}
          </p>
        ) : (
          threads.map((t) => (
            <NextLink
              key={t.id}
              href={`/p/${slug}/chat/${t.id}`}
              className={s.item}
              data-active={t.id === activeId}
            >
              <span className={s.itemTitle}>{t.title}</span>
              <span className={s.itemMeta}>
                {t.updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                {t.documentId && !scope ? ' · document' : ''}
              </span>
            </NextLink>
          ))
        )}
      </div>
    </aside>
  );
}
