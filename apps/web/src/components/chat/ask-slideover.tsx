'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { ThreadMode } from '@quire/shared';
import { ExternalLink, Plus, X } from 'lucide-react';
import NextLink from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  type AskContext,
  newThreadAction,
  setThreadModeAction,
  threadMessagesAction,
} from '@/app/actions/chat';
import { useProject } from '@/components/project-context';
import type { ChatMessage } from '@/db/schema';
import s from './chat.module.css';
import { SpendBanner } from './spend-banner';
import { ThreadView } from './thread-view';

/**
 * "Ask" from anywhere in a project, in a right-hand panel. Opens on the most recent chat in scope (the document's
 * chats, a homework question's chats, or the project-wide ones) rather than creating a new one; a new chat is created
 * only when asked for, or silently when the first question is sent and there is no chat yet.
 */
export function AskSlideover({
  slug,
  open,
  onClose,
  documentId,
  documentTitle,
  mode = 'default',
  questionId,
  questionLabel,
  context,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  documentId?: string | null;
  documentTitle?: string | null;
  mode?: ThreadMode;
  questionId?: string | null;
  questionLabel?: string | null;
  context: AskContext;
}) {
  const { base } = useProject();
  const [threads, setThreads] = useState(context.threads);
  const [threadId, setThreadId] = useState<string | null>(context.threads[0]?.id ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(context.messages);
  const [view, setView] = useState(0);
  useEffect(() => {
    setThreads(context.threads);
    setThreadId(context.threads[0]?.id ?? null);
    setMessages(context.messages);
    setView((v) => v + 1);
  }, [context]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const tutor = mode !== 'default' || Boolean(questionId);
  const current = threads.find((t) => t.id === threadId);
  const currentMode: ThreadMode = (current?.mode as ThreadMode | undefined) ?? mode;

  // `reset` clears the view (New chat button); the first-question path keeps the optimistic messages in place.
  const create = useCallback(
    async (reset: boolean) => {
      const id = await newThreadAction(slug, documentId ?? null, {
        mode: tutor ? 'tutor-hint' : 'default',
        questionId,
      });
      setThreads((t) => [
        { id, title: 'New chat', updatedAt: new Date(), mode: tutor ? 'tutor-hint' : 'default' },
        ...t,
      ]);
      setThreadId(id);
      if (reset) {
        setMessages([]);
        setView((v) => v + 1);
      }
      return id;
    },
    [slug, documentId, tutor, questionId],
  );
  const ensure = useCallback(() => create(false), [create]);
  const switchTo = async (id: string) => {
    const msgs = await threadMessagesAction(slug, id);
    setThreadId(id);
    setMessages(msgs);
    setView((v) => v + 1);
  };
  const toggleMode = async () => {
    if (!threadId) return;
    const next: ThreadMode = currentMode === 'tutor-full' ? 'tutor-hint' : 'tutor-full';
    await setThreadModeAction(slug, threadId, next);
    setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, mode: next } : t)));
  };

  if (!open) return null;
  const { summary, configured } = context;
  const disabled = !configured || summary.state === 'capped' || summary.state === 'blocked';
  const title = questionLabel
    ? `Tutor · ${questionLabel}`
    : documentTitle
      ? `Ask about “${documentTitle}”`
      : 'Ask this project';
  return (
    <>
      <div className={s.slideBackdrop} onClick={onClose} role="presentation" />
      <aside className={s.slide} role="dialog" aria-label="Ask">
        <div className={s.bar}>
          <span className={s.title}>{title}</span>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<Icon icon={X} />} onClick={onClose} />
        </div>
        <div className={s.switcher}>
          <select
            className={s.switcherSelect}
            aria-label="Chat"
            value={threadId ?? ''}
            onChange={(e) => void switchTo(e.target.value)}
            disabled={threads.length === 0}
          >
            {threads.length === 0 && <option value="">New chat</option>}
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" icon={<Icon icon={Plus} />} onClick={() => void create(true)}>
            New chat
          </Button>
          {threadId && (
            <NextLink
              href={`${base}/chat/${threadId}`}
              className={s.switcherLink}
              aria-label="Open in Chat"
              title="Open in Chat"
            >
              <Icon icon={ExternalLink} />
            </NextLink>
          )}
        </div>
        {tutor && (
          <label className={s.tutorToggle} data-testid="tutor-toggle">
            <input
              type="checkbox"
              checked={currentMode === 'tutor-full'}
              disabled={!threadId}
              onChange={() => void toggleMode()}
            />
            <span>
              <strong>Full solution</strong>
              {currentMode === 'tutor-full'
                ? ' — on: the tutor may give complete solutions and code.'
                : ' — off: hints, pointers to lectures and checks of your reasoning only.'}
            </span>
          </label>
        )}
        <SpendBanner summary={summary} configured={configured} />
        <ThreadView
          slug={slug}
          threadId={threadId}
          initial={messages}
          disabled={disabled}
          compact
          scopeTitle={questionLabel ?? documentTitle ?? null}
          mentionTargets={context.titles}
          onEnsureThread={ensure}
          resetKey={view}
          tutor={tutor}
        />
      </aside>
    </>
  );
}
