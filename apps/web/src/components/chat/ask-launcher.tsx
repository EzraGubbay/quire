'use client';

import { Icon } from '@ezragubbay/folio';
import type { ThreadMode } from '@quire/shared';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type AskContext, askContextAction } from '@/app/actions/chat';
import { AskSlideover } from './ask-slideover';

export interface AskDetail {
  documentId?: string;
  documentTitle?: string;
  /** Homework: tutor-hint opens a hints-only chat scoped to a question. */
  mode?: ThreadMode;
  questionId?: string;
  questionLabel?: string;
}

interface Scope {
  documentId: string | null;
  documentTitle: string | null;
  mode: ThreadMode;
  questionId: string | null;
  questionLabel: string | null;
}

const EMPTY: Scope = {
  documentId: null,
  documentTitle: null,
  mode: 'default',
  questionId: null,
  questionLabel: null,
};

/** App-bar "Ask" button plus the slide-over. Other components open it by dispatching `quire:ask` with an AskDetail. */
export function AskLauncher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(EMPTY);
  const [context, setContext] = useState<AskContext | null>(null);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<AskDetail>).detail ?? {};
      setScope({
        documentId: d.documentId ?? null,
        documentTitle: d.documentTitle ?? null,
        mode: d.mode ?? 'default',
        questionId: d.questionId ?? null,
        questionLabel: d.questionLabel ?? null,
      });
      setContext(null);
      setOpen(true);
    };
    window.addEventListener('quire:ask', onAsk);
    return () => window.removeEventListener('quire:ask', onAsk);
  }, []);
  // Fresh context every time the panel opens: the chats in scope may have changed elsewhere.
  useEffect(() => {
    if (open)
      askContextAction(slug, scope.documentId, { mode: scope.mode, questionId: scope.questionId }).then(
        setContext,
      );
  }, [open, slug, scope.documentId, scope.mode, scope.questionId]);
  return (
    <>
      <button
        type="button"
        aria-label="Ask"
        title="Ask (AI)"
        onClick={() => {
          setScope(EMPTY);
          setContext(null);
          setOpen(true);
        }}
        style={{
          display: 'inline-flex',
          padding: 6,
          color: 'var(--eg-text-2)',
          background: 'none',
          border: 0,
          cursor: 'pointer',
        }}
      >
        <Icon icon={MessageSquare} />
      </button>
      {context && (
        <AskSlideover
          slug={slug}
          open={open}
          onClose={() => setOpen(false)}
          documentId={scope.documentId}
          documentTitle={scope.documentTitle}
          mode={scope.mode}
          questionId={scope.questionId}
          questionLabel={scope.questionLabel}
          context={context}
        />
      )}
    </>
  );
}
