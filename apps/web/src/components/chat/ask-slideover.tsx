'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { newThreadAction } from '@/app/actions/chat';
import type { SpendSummary } from '@/lib/ai/ledger';
import s from './chat.module.css';
import { SpendBanner } from './spend-banner';
import { ThreadView } from './thread-view';

/** "Ask" from anywhere in a project. Opens a fresh thread (optionally scoped to a document) in a right-hand panel. */
export function AskSlideover({
  slug,
  open,
  onClose,
  documentId,
  documentTitle,
  summary,
  configured,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  documentId?: string | null;
  documentTitle?: string | null;
  summary: SpendSummary;
  configured: boolean;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setThreadId(null);
    newThreadAction(slug, documentId ?? null).then(setThreadId);
  }, [open, slug, documentId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const disabled = !configured || summary.state === 'capped' || summary.state === 'blocked';
  return (
    <>
      <div className={s.slideBackdrop} onClick={onClose} role="presentation" />
      <aside className={s.slide} role="dialog" aria-label="Ask">
        <div className={s.bar}>
          <span className={s.title}>
            {documentTitle ? `Ask about “${documentTitle}”` : 'Ask this project'}
          </span>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<Icon icon={X} />} onClick={onClose} />
        </div>
        <SpendBanner summary={summary} configured={configured} />
        {threadId ? (
          <ThreadView
            slug={slug}
            threadId={threadId}
            initial={[]}
            disabled={disabled}
            compact
            scopeTitle={documentTitle ?? null}
          />
        ) : (
          <div className={s.empty}>Starting…</div>
        )}
      </aside>
    </>
  );
}
