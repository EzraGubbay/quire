'use client';

import { Icon } from '@ezragubbay/folio';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type AskContext, askContextAction } from '@/app/actions/chat';
import { AskSlideover } from './ask-slideover';

/** App-bar "Ask" button plus the slide-over. Other components can open it by dispatching `quire:ask` with {documentId, documentTitle}. */
export function AskLauncher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<{ documentId: string | null; documentTitle: string | null }>({
    documentId: null,
    documentTitle: null,
  });
  const [context, setContext] = useState<AskContext | null>(null);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<{ documentId?: string; documentTitle?: string }>).detail ?? {};
      setScope({ documentId: d.documentId ?? null, documentTitle: d.documentTitle ?? null });
      setContext(null);
      setOpen(true);
    };
    window.addEventListener('quire:ask', onAsk);
    return () => window.removeEventListener('quire:ask', onAsk);
  }, []);
  // Fresh context every time the panel opens: the chats in scope may have changed elsewhere.
  useEffect(() => {
    if (open) askContextAction(slug, scope.documentId).then(setContext);
  }, [open, slug, scope.documentId]);
  return (
    <>
      <button
        type="button"
        aria-label="Ask"
        title="Ask this project (AI)"
        onClick={() => {
          setScope({ documentId: null, documentTitle: null });
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
          context={context}
        />
      )}
    </>
  );
}
