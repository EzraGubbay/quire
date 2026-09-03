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
}: {
  slug: string;
  threads: ChatThread[];
  activeId?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <aside className={s.rail} aria-label="Chats">
      <div className={s.railHead}>
        <h2 className={s.railTitle}>Chats · {threads.length}</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New chat"
          icon={<Icon icon={Plus} />}
          disabled={pending}
          onClick={() => start(() => newThreadAndGoAction(slug))}
        />
      </div>
      <div className={s.list}>
        {threads.length === 0 ? (
          <p className={s.itemMeta} style={{ padding: 10 }}>
            No chats yet.
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
                {t.documentId ? ' · document' : ''}
              </span>
            </NextLink>
          ))
        )}
      </div>
    </aside>
  );
}
