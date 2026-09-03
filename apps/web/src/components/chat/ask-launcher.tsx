'use client';

import { Icon } from '@ezragubbay/folio';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { spendSummaryAction } from '@/app/actions/ai';
import type { SpendSummary } from '@/lib/ai/ledger';
import { AskSlideover } from './ask-slideover';

/** App-bar "Ask" button plus the slide-over. Other components can open it by dispatching `quire:ask` with {documentId, documentTitle}. */
export function AskLauncher({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<{ documentId: string | null; documentTitle: string | null }>({
    documentId: null,
    documentTitle: null,
  });
  const [state, setState] = useState<{ summary: SpendSummary; configured: boolean } | null>(null);
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<{ documentId?: string; documentTitle?: string }>).detail ?? {};
      setScope({ documentId: d.documentId ?? null, documentTitle: d.documentTitle ?? null });
      setOpen(true);
    };
    window.addEventListener('quire:ask', onAsk);
    return () => window.removeEventListener('quire:ask', onAsk);
  }, []);
  useEffect(() => {
    if (open) spendSummaryAction().then(setState);
  }, [open]);
  return (
    <>
      <button
        type="button"
        aria-label="Ask"
        title="Ask this project (AI)"
        onClick={() => {
          setScope({ documentId: null, documentTitle: null });
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
      {state && (
        <AskSlideover
          slug={slug}
          open={open}
          onClose={() => setOpen(false)}
          documentId={scope.documentId}
          documentTitle={scope.documentTitle}
          summary={state.summary}
          configured={state.configured}
        />
      )}
    </>
  );
}
