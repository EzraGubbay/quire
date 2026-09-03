'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { deleteThreadAction } from '@/app/actions/chat';
import s from '@/components/chat/chat.module.css';
import type { ChatThread } from '@/db/schema';

export function ThreadBar({
  slug,
  thread,
  scopeTitle,
}: {
  slug: string;
  thread: ChatThread;
  scopeTitle: string | null;
}) {
  const [pending, start] = useTransition();
  return (
    <div className={s.bar}>
      <h1 className={s.title}>{thread.title}</h1>
      {scopeTitle && <span className={s.scope}>about: {scopeTitle}</span>}
      <Button
        variant="ghost"
        size="sm"
        icon={<Icon icon={Trash2} />}
        aria-label="Delete chat"
        disabled={pending}
        onClick={() => {
          if (window.confirm('Delete this chat?')) start(() => deleteThreadAction(slug, thread.id));
        }}
      >
        Delete
      </Button>
    </div>
  );
}
