'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Send, Square } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownView } from '@/components/documents/markdown-view';
import type { ChatMessage } from '@/db/schema';
import type { Citation } from '@/lib/chat';
import { renderMarkdownClient } from '@/lib/markdown-client';
import s from './chat.module.css';

type Msg = Pick<ChatMessage, 'id' | 'role' | 'content' | 'citations' | 'error' | 'model' | 'costUsd'> & {
  pending?: boolean;
};

export function ThreadView({
  slug,
  threadId,
  initial,
  disabled,
  compact = false,
  scopeTitle,
}: {
  slug: string;
  threadId: string;
  initial: Msg[];
  /** Budget reached / provider blocked / unconfigured: composer is disabled with the banner explaining why. */
  disabled: boolean;
  compact?: boolean;
  scopeTitle?: string | null;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = useCallback(async () => {
    const question = draft.trim();
    if (!question || busy) return;
    setDraft('');
    setBusy(true);
    const tempUser = `u-${Date.now()}`;
    const tempAsst = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      {
        id: tempUser,
        role: 'user',
        content: question,
        citations: [],
        error: null,
        model: null,
        costUsd: null,
      },
      {
        id: tempAsst,
        role: 'assistant',
        content: '',
        citations: [],
        error: null,
        model: null,
        costUsd: null,
        pending: true,
      },
    ]);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch(`/api/projects/${slug}/chat/${threadId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setMessages((m) =>
          m.map((x) =>
            x.id === tempAsst ? { ...x, pending: false, error: err.error ?? 'Request failed' } : x,
          ),
        );
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as {
            type: string;
            text?: string;
            message?: Msg;
            saved?: Msg;
            kind?: string;
          };
          if (ev.type === 'delta')
            setMessages((m) =>
              m.map((x) => (x.id === tempAsst ? { ...x, content: x.content + (ev.text ?? '') } : x)),
            );
          else if (ev.type === 'done' && ev.message)
            setMessages((m) => m.map((x) => (x.id === tempAsst ? { ...ev.message!, pending: false } : x)));
          else if (ev.type === 'error')
            setMessages((m) =>
              m.map((x) =>
                x.id === tempAsst ? { ...x, pending: false, error: ev.message as unknown as string } : x,
              ),
            );
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        setMessages((m) =>
          m.map((x) => (x.id === tempAsst ? { ...x, pending: false, error: (err as Error).message } : x)),
        );
    } finally {
      setBusy(false);
      abort.current = null;
      router.refresh();
    }
  }, [draft, busy, slug, threadId, router]);

  return (
    <>
      <div className={s.messages} style={compact ? { padding: 16 } : undefined}>
        {messages.length === 0 && (
          <div className={s.empty}>
            <p>
              {scopeTitle
                ? `Ask about “${scopeTitle}”.`
                : 'Ask about anything in this project: documents, notes, annotations, sources.'}{' '}
              Answers cite the passages they use.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        <div ref={bottom} />
      </div>
      <div className={s.composer}>
        <textarea
          className={s.input}
          aria-label="Question"
          placeholder={
            disabled
              ? 'AI is unavailable right now (see the notice above).'
              : 'Ask a question… Enter to send, Shift+Enter for a new line'
          }
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className={s.composerRow}>
          <span className={s.hint}>
            Retrieval over what is indexed in this project. Costs are counted against the monthly cap.
          </span>
          {busy ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon icon={Square} />}
              onClick={() => abort.current?.abort()}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<Icon icon={Send} />}
              disabled={disabled || !draft.trim()}
              onClick={() => void send()}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function Message({ m }: { m: Msg }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (m.role === 'assistant' && m.content) renderMarkdownClient(m.content).then(setHtml);
  }, [m.content, m.role]);
  const cites = (m.citations as Citation[]) ?? [];
  return (
    <div className={s.msg} data-role={m.role} data-testid="chat-message">
      <div className={s.bubble}>
        {m.role === 'user' ? (
          m.content
        ) : m.error ? (
          <span className={s.error}>{m.error}</span>
        ) : html ? (
          <MarkdownView html={html} />
        ) : m.pending ? (
          '…'
        ) : (
          ''
        )}
      </div>
      {cites.length > 0 && (
        <div className={s.cites}>
          {cites.map((c) => (
            <NextLink key={c.n} href={c.href} className={s.cite} title={c.title}>
              <b>[{c.n}]</b>
              {c.title}
              {c.pageNo ? ` · p.${c.pageNo}` : ''}
            </NextLink>
          ))}
        </div>
      )}
      {m.role === 'assistant' && !m.pending && !m.error && m.model && (
        <span className={s.meta}>
          {m.model}
          {m.costUsd != null ? ` · $${m.costUsd.toFixed(4)}` : ''}
        </span>
      )}
    </div>
  );
}
