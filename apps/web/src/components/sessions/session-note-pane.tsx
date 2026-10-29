'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ExternalLink, FileText, Quote, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  type ActionState,
  listNoteOptionsAction,
  newSessionNoteAction,
  saveSessionNoteAction,
  sessionNoteAction,
  setSessionNoteAction,
} from '@/app/actions/sessions';
import { MarkdownEditor, type MarkdownEditorHandle } from '@/components/editor/markdown-editor';
import { SynthesizeButton } from '@/components/notes/synthesize-button';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import type { Note } from '@/db/schema';
import { announceNoteChange } from '@/lib/note-signal';
import s from './sessions.module.css';

type NoteOption = { id: string; title: string; sessionId: string | null };

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
  const [chooserOpen, setChooserOpen] = useState(false);
  const [options, setOptions] = useState<NoteOption[] | null>(null);
  const [choosing, setChoosing] = useState(false);
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
        if (!res.error) announceNoteChange(n.id);
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
  // Flush on tab close so the last sentence is not lost, and when Ask opens so the question sees the latest note.
  useEffect(() => {
    const flush = () => {
      if (status !== 'dirty') return;
      if (timer.current) clearTimeout(timer.current);
      void save(body);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('quire:ask', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('quire:ask', flush);
    };
  }, [status, body, save]);

  const cite = () => {
    if (!deckTitle) return;
    editor.current?.insertAtCursor(`[[${deckTitle}#${currentPage}]] `);
  };

  const openChooser = useCallback(async () => {
    setChooserOpen(true);
    setOptions(null);
    try {
      setOptions(await listNoteOptionsAction(slug));
    } catch {
      setOptions([]);
    }
  }, [slug]);

  // Make `run`'s note this session's note. Persist the current note first (switching never loses edits), then load
  // the chosen/new note into the editor. The previously tied note is only unlinked server-side, never deleted.
  const switchTo = useCallback(
    async (run: () => Promise<ActionState & { note?: Note }>) => {
      setChoosing(true);
      if (status === 'dirty') {
        if (timer.current) clearTimeout(timer.current);
        await save(body);
      }
      const res = await run();
      setChoosing(false);
      if (res.error || !res.note) {
        setStatus('error');
        return;
      }
      setNote(res.note);
      setBody(res.note.body);
      setStatus('saved');
      creating.current = null;
      setChooserOpen(false);
    },
    [status, body, save],
  );

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
          icon={<Icon icon={FileText} />}
          title="Choose a different note, or start a new one, as this lecture's note"
          onClick={openChooser}
        >
          Change note
        </Button>
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
          <a
            href={`${base}/notes/${note.slug}`}
            target="_blank"
            rel="noopener"
            className={s.paneLink}
            title="Open in Notes (new tab)"
            aria-label="Open in Notes in a new tab"
          >
            <Icon icon={ExternalLink} />
          </a>
        )}
        {!note && canSynthesize && (
          <span className={s.paneHint} title="Start typing to create the note">
            <Icon icon={Sparkles} /> Synthesize after you take notes
          </span>
        )}
      </div>
      <div className={s.paneEditor}>
        <MarkdownEditor
          key={note?.id ?? 'empty'}
          ref={editor}
          value={body}
          onChange={onChange}
          linkTargets={linkTargets}
          macros={macros}
        />
      </div>
      {chooserOpen && (
        <Dialog open title="Lecture note" onClose={() => setChooserOpen(false)}>
          <div className={s.form} data-testid="note-chooser">
            <Field
              label="Use an existing note"
              hint="Whatever note is attached now stays in Notes — switching never deletes it."
            >
              <select
                className={s.noteSelect}
                aria-label="Existing note"
                defaultValue=""
                disabled={choosing || options === null}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) void switchTo(() => setSessionNoteAction(slug, sessionId, id));
                }}
              >
                <option value="">{options === null ? 'Loading…' : 'Choose a note…'}</option>
                {(options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                    {o.id === note?.id ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <DialogActions>
              <Button variant="secondary" onClick={() => setChooserOpen(false)} disabled={choosing}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={choosing}
                onClick={() => void switchTo(() => newSessionNoteAction(slug, sessionId))}
              >
                {choosing ? 'Working…' : 'New blank note'}
              </Button>
            </DialogActions>
          </div>
        </Dialog>
      )}
    </div>
  );
}
