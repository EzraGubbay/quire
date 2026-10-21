'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ExternalLink, Quote, Sparkles } from 'lucide-react';
import NextLink from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { saveSessionNoteAction, sessionNoteAction } from '@/app/actions/sessions';
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/editor/markdown-editor';
import { SynthesizeButton } from '@/components/notes/synthesize-button';
import { useProject } from '@/components/project-context';
import type { Note } from '@/db/schema';
import s from './sessions.module.css';

/**
 * The raw note beside the slides. Created on the first keystroke (so empty lectures do not litter the Raw folder),
 * autosaved 1.5 s after typing stops. "Cite slide" drops a `[[Deck title#page]]` link at the cursor.
 */
export function SessionNotePane({
  slug,
  sessionId,
  note: initial,
  deckTitle,
  currentPage,
  linkTargets,
  macros,
  canSynthesize,
}: {
  slug: string;
  sessionId: string;
  note: Note | null;
  /** Title of the deck being viewed, for slide citations. */
  deckTitle: string | null;
  currentPage: number;
  linkTargets: string[];
  macros: string[];
  canSynthesize: boolean;
}) {
  const { base } = useProject();
  const [note, setNote] = useState<Note | null>(initial);
  const [body, setBody] = useState(initial?.body ?? '');
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const editor = useRef<MarkdownEditorHandle>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creating = useRef<Promise<Note> | null>(null);
  const [, start] = useTransition();

  const ensureNote = useCallback(async (): Promise<Note> => {
    if (note) return note;
    if (!creating.current) {
      creating.current = sessionNoteAction(slug, sessionId).then((n) => {
        setNote(n);
        return n;
      });
    }
    return creating.current;
  }, [note, slug, sessionId]);

  const save = useCallback(
    async (text: string) => {
      setStatus('saving');
      try {
        const n = await ensureNote();
        const res = await saveSessionNoteAction(slug, n.id, text);
        setStatus(res.error ? 'error' : 'saved');
      } catch {
        setStatus('error');
      }
    },
    [ensureNote, slug],
  );

  const onChange = (text: string) => {
    setBody(text);
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(text), 1500);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // Flush on unmount or tab close so the last sentence is not lost.
  useEffect(() => {
    const flush = () => {
      if (status === 'dirty') void save(body);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [status, body, save]);

  const cite = () => {
    if (!deckTitle) return;
    editor.current?.insertAtCursor(`[[${deckTitle}#${currentPage}]] `);
  };

  return (
    <div className={s.pane} data-testid="session-note-pane">
      <div className={s.paneBar}>
        <span className={s.paneTitle}>{note ? note.title : 'Raw note'}</span>
        <span className={s.paneStatus}>
          {status === 'saving'
            ? 'Saving…'
            : status === 'dirty'
              ? 'Unsaved'
              : status === 'saved'
                ? 'Saved'
                : status === 'error'
                  ? 'Save failed'
                  : note
                    ? 'Saved'
                    : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={Quote} />}
          title={deckTitle ? `Cite slide ${currentPage}` : 'No deck to cite'}
          disabled={!deckTitle}
          onClick={cite}
        >
          Cite slide {currentPage}
        </Button>
        {note && canSynthesize && (
          <SynthesizeButton slug={slug} note={note} size="sm" onStarted={() => start(() => {})} />
        )}
        {note && (
          <NextLink
            href={`${base}/notes/${note.slug}`}
            className={s.paneLink}
            title="Open in Notes"
            aria-label="Open in Notes"
          >
            <Icon icon={ExternalLink} />
          </NextLink>
        )}
        {!note && canSynthesize && (
          <span className={s.paneHint} title="Start typing to create the note">
            <Icon icon={Sparkles} /> Synthesize after you take notes
          </span>
        )}
      </div>
      <div className={s.paneEditor}>
        <MarkdownEditor
          ref={editor}
          value={body}
          onChange={onChange}
          linkTargets={linkTargets}
          macros={macros}
        />
      </div>
    </div>
  );
}
