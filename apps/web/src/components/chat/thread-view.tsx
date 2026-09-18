'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { RotateCcw, Send, Square } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownView } from '@/components/documents/markdown-view';
import { useWikiLinkComplete } from '@/components/editor/wikilink-complete';
import type { ChatMessage } from '@/db/schema';
import type { Citation } from '@/lib/chat';
import { renderMarkdownClient } from '@/lib/markdown-client';
import s from './chat.module.css';

type Msg = Pick<ChatMessage, 'id' | 'role' | 'content' | 'citations' | 'error' | 'model' | 'costUsd'> & {
  pending?: boolean;
  fallback?: boolean;
};

/** `[[` or `doc.` before the caret opens the document picker; the completion is written as [[Title]]. */
const MENTION = /(?:\[\[|doc\.)([^\]\n]*)$/;

export function ThreadView({
  slug,
  threadId,
  initial,
  disabled,
  compact = false,
  scopeTitle,
  mentionTargets = [],
  onEnsureThread,
  resetKey,
}: {
  slug: string;
  /** Null until the first question creates the thread (see onEnsureThread). */
  threadId: string | null;
  initial: Msg[];
  /** Budget reached / provider blocked / unconfigured: composer is disabled with the banner explaining why. */
  disabled: boolean;
  compact?: boolean;
  scopeTitle?: string | null;
  /** Document titles offered after typing `[[` or `doc.`. */
  mentionTargets?: string[];
  /** Creates the thread on first send when none exists yet, returning its id. */
  onEnsureThread?: () => Promise<string>;
  /** Bumped by the owner when a different chat is shown; `initial` is re-read only then. */
  resetKey?: number;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useWikiLinkComplete({
    textareaRef,
    value: draft,
    targets: mentionTargets,
    onChange: setDraft,
    pattern: MENTION,
    placement: 'above',
    label: 'Documents',
  });

  // A different chat was selected (Ask panel switcher or New chat): show its messages. Not on every `initial`
  // change: the page re-renders after each answer and would wipe live-only state such as the fallback note.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger; initial is read then.
  useEffect(() => {
    if (resetKey !== undefined) setMessages(initial);
  }, [resetKey]);

  useEffect(() => {
    if(isAtBottomRef) {
        bottom.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  const handleScroll = () => {
    const lmnt = containerRef.current;
    if (!lmnt) return;
    const atBottom = lmnt.scrollHeight - lmnt.scrollTop - lmnt.clientHeight <= 40;
    isAtBottomRef.current = atBottom;
  }

  const run = useCallback(
    async (question: string, retry: boolean) => {
      if (busy) return;
      setBusy(true);
      const tempAsst = `a-${Date.now()}`;
      setMessages((m) => [
        // A retry replaces the failed answer instead of stacking another one.
        ...(retry ? m.filter((x) => !(x.role === 'assistant' && x.error)) : m),
        ...(retry
          ? []
          : [
              {
                id: `u-${Date.now()}`,
                role: 'user',
                content: question,
                citations: [],
                error: null,
                model: null,
                costUsd: null,
              } as Msg,
            ]),
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
      const fail = (error: string) =>
        setMessages((m) => m.map((x) => (x.id === tempAsst ? { ...x, pending: false, error } : x)));
      try {
        const id = threadId ?? (await onEnsureThread?.());
        if (!id) throw new Error('No chat to send to');
        const res = await fetch(`/api/projects/${slug}/chat/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(retry ? { retry: true } : { question }),
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          fail(err.error ?? 'Request failed');
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
              fallback?: boolean;
            };
            if (ev.type === 'delta')
              setMessages((m) =>
                m.map((x) => (x.id === tempAsst ? { ...x, content: x.content + (ev.text ?? '') } : x)),
              );
            else if (ev.type === 'done' && ev.message)
              setMessages((m) =>
                m.map((x) =>
                  x.id === tempAsst ? { ...ev.message!, pending: false, fallback: ev.fallback ?? false } : x,
                ),
              );
            else if (ev.type === 'error')
              setMessages((m) =>
                m.map((x) =>
                  x.id === tempAsst
                    ? {
                        ...x,
                        pending: false,
                        content: ev.saved?.content ?? x.content,
                        error: ev.message as unknown as string,
                      }
                    : x,
                ),
              );
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') fail((err as Error).message);
      } finally {
        setBusy(false);
        abort.current = null;
        router.refresh();
      }
    },
    [busy, slug, threadId, onEnsureThread, router],
  );

  const send = useCallback(() => {
    const question = draft.trim();
    if (!question) return;
    setDraft('');
    void run(question, false);
  }, [draft, run]);

  const lastFailed = [...messages].reverse().find((m) => m.role === 'assistant')?.error
    ? messages.at(-1)
    : null;

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
              {mentionTargets.length > 0 && !scopeTitle
                ? ' Type doc. or [[ to name a specific document.'
                : ''}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <Message
            key={m.id}
            m={m}
            onRetry={m === lastFailed && !busy && threadId ? () => void run(m.content, true) : undefined}
          />
        ))}
        <div ref={bottom} />
      </div>
      <div className={s.composer}>
        <div className={s.composerField}>
          <textarea
            ref={textareaRef}
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
            onKeyUp={mention.refresh}
            onClick={mention.refresh}
            // Phone: the bottom tab bar steps aside while the keyboard is up.
            onFocus={() => {
              document.documentElement.dataset.keyboard = 'true';
            }}
            onBlur={() => {
              delete document.documentElement.dataset.keyboard;
            }}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {mention.list}
        </div>
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
              onClick={send}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/** OpenAI's own wording for its transient 500s is long; say what matters and offer the retry. */
function friendly(error: string): string {
  if (/server had an error processing your request/i.test(error))
    return 'OpenAI had a server error while answering. This is on their side and usually passes in a moment.';
  return error;
}

function Message({ m, onRetry }: { m: Msg; onRetry?: () => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    // Typeset once the answer is complete: re-rendering math on every streamed token leaves blank gaps.
    if (m.role === 'assistant' && m.content && !m.pending) renderMarkdownClient(m.content).then(setHtml);
  }, [m.content, m.role, m.pending]);
  const cites = (m.citations as Citation[]) ?? [];
  return (
    <div className={s.msg} data-role={m.role} data-testid="chat-message">
      <div className={s.bubble}>
        {m.role === 'user' ? (
          m.content
        ) : m.pending ? (
          <span className={s.streaming}>{m.content || '…'}</span>
        ) : html ? (
          <MarkdownView html={html} />
        ) : m.content ? (
          <span className={s.streaming}>{m.content}</span>
        ) : null}
        {m.error && (
          <div className={s.errorRow} data-testid="chat-error">
            <span className={s.error}>
              {m.content ? 'The answer was cut off: ' : ''}
              {friendly(m.error)}
            </span>
            {onRetry && (
              <Button variant="secondary" size="sm" icon={<Icon icon={RotateCcw} />} onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
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
          {m.fallback ? ' · answered by the light model after the main one errored' : ''}
        </span>
      )}
    </div>
  );
}
