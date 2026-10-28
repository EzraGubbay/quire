'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ArrowUpRight, Check, Pencil, RotateCw, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  deleteNoteAction,
  followWikiLinkAction,
  promoteNoteAction,
  retrySynthesisAction,
  setSynthesizedFromAction,
  updateNoteAction,
} from '@/app/actions/notes';
import { MarkdownView } from '@/components/documents/markdown-view';
import { MarkdownEditor } from '@/components/editor/markdown-editor';
import { useProject } from '@/components/project-context';
import { PollWhile } from '@/components/ui/poll-while';
import type { Note } from '@/db/schema';
import { renderMarkdownClient } from '@/lib/markdown-client';
import { announceNoteChange } from '@/lib/note-signal';
import type { Backlink } from '@/lib/notes';
import { LiveNote } from './live-note';
import s from './notes.module.css';
import { SynthesizeButton } from './synthesize-button';

export interface NoteRef {
  id?: string;
  title: string;
  slug: string;
  status?: Note['status'];
}

export function NoteView({
  backHref,
  slug,
  note,
  html,
  backlinks,
  unresolved,
  linkTargets,
  editing,
  macros,
  editLevel = 'on',
  course = false,
  canSynthesize = false,
  synthesizedFrom = null,
  synthesizedInto = [],
  rawCandidates = [],
}: {
  /** Phone: link back to the notes list, shown in the bar. */
  backHref?: string;
  slug: string;
  note: Note;
  html: string;
  backlinks: Backlink[];
  unresolved: string[];
  linkTargets: string[];
  editing: boolean;
  macros: string[];
  /** notes.edit feature level: 'lite' = plain textarea without the split preview. */
  editLevel?: 'on' | 'lite' | 'off';
  course?: boolean;
  /** Raw notes in a course get a Synthesize button. */
  canSynthesize?: boolean;
  synthesizedFrom?: NoteRef | null;
  /** Synthesized notes made from this raw note, oldest first. */
  synthesizedInto?: NoteRef[];
  /** For hand-written synthesized notes: notes that can be set as the source. */
  rawCandidates?: { id: string; title: string }[];
}) {
  const router = useRouter();
  const { base } = useProject();
  const [pending, start] = useTransition();
  const follow = useCallback((name: string) => start(() => followWikiLinkAction(slug, name)), [slug]);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (note.status === 'generating')
    return (
      <div className={s.main} data-testid="note-generating">
        <PollWhile active />
        <div className={s.bar}>
          {backHref && (
            <NextLink href={backHref} className={s.back}>
              ← Notes
            </NextLink>
          )}
          <h1 className={s.title} style={{ color: 'var(--eg-muted)' }}>
            {note.title}
          </h1>
          <span className={s.status}>Synthesizing…</span>
        </div>
        {synthesizedFrom && (
          <p className={s.sourceLine}>
            Synthesized from{' '}
            <NextLink href={`${base}/notes/${synthesizedFrom.slug}`}>{synthesizedFrom.title}</NextLink>
          </p>
        )}
        <div className={s.generating} role="status" aria-busy="true" aria-label="Synthesizing">
          <div className={s.skelLine} style={{ width: '42%' }} />
          <div className={s.skelLine} style={{ width: '92%' }} />
          <div className={s.skelLine} style={{ width: '86%' }} />
          <div className={s.skelLine} style={{ width: '64%' }} />
          <div className={s.skelLine} style={{ width: '30%', marginTop: 12 }} />
          <div className={s.skelLine} style={{ width: '88%' }} />
          <div className={s.skelLine} style={{ width: '71%' }} />
        </div>
      </div>
    );

  if (editing)
    return (
      <NoteEditor
        slug={slug}
        note={note}
        linkTargets={linkTargets}
        macros={macros}
        lite={editLevel === 'lite'}
        backHref={backHref}
      />
    );

  return (
    <div className={s.main}>
      <div className={s.bar}>
        {backHref && (
          <NextLink href={backHref} className={s.back}>
            ← Notes
          </NextLink>
        )}
        <h1 className={s.title}>{note.title}</h1>
        <span className={s.status}>
          edited {note.updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
        <LiveNote slug={slug} noteId={note.id} updatedAt={note.updatedAt.toISOString()} />
        {canSynthesize && note.status === 'ready' && <SynthesizeButton slug={slug} note={note} />}
        <NextLink href={`${base}/notes/${note.slug}?edit=1`} className={s.chip}>
          <Icon icon={Pencil} /> Edit
        </NextLink>
        {!course && (
          <button
            type="button"
            className={s.chip}
            disabled={pending}
            onClick={() => start(() => promoteNoteAction(slug, note.id))}
            title="Turn this note into a Markdown document"
          >
            <Icon icon={ArrowUpRight} /> Promote to document
          </button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={Trash2} />}
          aria-label="Delete note"
          onClick={() => {
            if (window.confirm(`Delete "${note.title}"?`)) start(() => deleteNoteAction(slug, note.id));
          }}
        >
          Delete
        </Button>
      </div>
      {(synthesizedFrom || synthesizedInto.length > 0 || rawCandidates.length > 0) && (
        <p className={s.sourceLine} data-testid="synth-lines">
          {synthesizedFrom && (
            <>
              Synthesized from{' '}
              <NextLink href={`${base}/notes/${synthesizedFrom.slug}`}>{synthesizedFrom.title}</NextLink>
              {'. '}
            </>
          )}
          {synthesizedInto.length > 0 && (
            <>
              Synthesized into{' '}
              {synthesizedInto.map((n, i) => (
                <span key={n.slug}>
                  {i > 0 && ', '}
                  <NextLink href={`${base}/notes/${n.slug}`}>{n.title}</NextLink>
                  {i < synthesizedInto.length - 1 && ' (older)'}
                  {n.status === 'generating' && ' (generating)'}
                  {n.status === 'failed' && ' (failed)'}
                </span>
              ))}
              .
            </>
          )}
          {!synthesizedFrom && rawCandidates.length > 0 && (
            <>
              {' '}
              <label>
                Source note:{' '}
                <select
                  className={s.chip}
                  defaultValue=""
                  onChange={(e) =>
                    start(async () => {
                      await setSynthesizedFromAction(slug, note.id, e.target.value || null);
                      router.refresh();
                    })
                  }
                >
                  <option value="">none</option>
                  {rawCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </p>
      )}
      {note.status === 'failed' && (
        <div className={s.failed} role="alert" data-testid="note-failed">
          <strong>Synthesis failed.</strong>
          <span>{note.error}</span>
          {retryError && <span>{retryError}</span>}
          <div>
            <Button
              variant="primary"
              size="sm"
              icon={<Icon icon={RotateCw} />}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await retrySynthesisAction(slug, note.id);
                  if (res.error) setRetryError(res.error);
                  else router.refresh();
                })
              }
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      <div className={s.read}>
        <MarkdownView html={html || '<p></p>'} onWikiLink={follow} />
        <aside className={s.aside} aria-label="Links">
          <div>
            <h3 className={s.asideTitle}>Linked from</h3>
            {backlinks.length === 0 ? (
              <span className={s.dangling}>Nothing links here yet.</span>
            ) : (
              backlinks.map((b) => (
                <NextLink
                  key={`${b.fromKind}:${b.fromId}`}
                  href={
                    b.href
                      ? `${base}/${b.href}`
                      : b.fromKind === 'note'
                        ? `${base}/notes/${b.fromId}`
                        : `${base}/documents/${b.fromId}`
                  }
                >
                  {b.title}
                </NextLink>
              ))
            )}
          </div>
          {unresolved.length > 0 && (
            <div>
              <h3 className={s.asideTitle}>Unresolved links</h3>
              {unresolved.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={s.chip}
                  onClick={() => follow(name)}
                  title="Create this note"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The direct note editor under Notes. Like the in-lecture note pane, it autosaves 1.5 s after typing
 * stops (title or body) and flushes on tab close / when Ask opens, so nothing is lost; the status pill
 * shows where the save is. A rename changes the note's slug, so a save that renames soft-replaces the URL
 * to the new `?edit=1` slug (kept reload-safe) — body-only saves don't touch the URL. "Done" flushes then
 * returns to the read view.
 */
function NoteEditor({
  slug,
  note,
  linkTargets,
  macros,
  lite = false,
  backHref,
}: {
  slug: string;
  note: Note;
  linkTargets: string[];
  macros: string[];
  lite?: boolean;
  backHref?: string;
}) {
  const router = useRouter();
  const { base } = useProject();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [html, setHtml] = useState('');
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [pending, start] = useTransition();
  // Latest values for the debounced save and the close/unload flush, which run outside render.
  const titleRef = useRef(title);
  titleRef.current = title;
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const slugRef = useRef(note.slug);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      renderMarkdownClient(body).then(setHtml);
    }, 250);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [body]);

  const save = useCallback(
    async (close = false) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      setStatus('saving');
      try {
        const res = await updateNoteAction(slug, note.id, { title: titleRef.current, body: bodyRef.current });
        if (res.error) {
          setStatus('error');
          return;
        }
        setStatus('saved');
        announceNoteChange(note.id);
        const renamed = !!res.noteSlug && res.noteSlug !== slugRef.current;
        if (res.noteSlug) slugRef.current = res.noteSlug;
        if (close) start(() => router.push(`${base}/notes/${slugRef.current}`));
        else if (renamed) start(() => router.replace(`${base}/notes/${slugRef.current}?edit=1`));
      } catch {
        setStatus('error');
      }
    },
    [slug, note.id, router, base],
  );

  const scheduleSave = useCallback(() => {
    setStatus('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(false), 1500);
  }, [save]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  // Flush the pending save on tab close and when Ask opens (so the question sees the latest note).
  useEffect(() => {
    const flush = () => {
      if (status !== 'dirty') return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void save(false);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('quire:ask', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('quire:ask', flush);
    };
  }, [status, save]);

  const statusLabel =
    status === 'saving'
      ? 'Saving…'
      : status === 'dirty'
        ? 'Unsaved changes'
        : status === 'error'
          ? 'Save failed'
          : 'Saved';

  return (
    <div className={s.main}>
      <div className={s.bar}>
        {backHref && (
          <NextLink href={backHref} className={s.back}>
            ← Notes
          </NextLink>
        )}
        <input
          className={s.titleInput}
          aria-label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            scheduleSave();
          }}
        />
        <span className={s.status} data-status={status}>
          {statusLabel}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={status !== 'dirty' && status !== 'error'}
          onClick={() => save(false)}
        >
          Save
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Icon icon={Check} />}
          disabled={pending}
          onClick={() =>
            status === 'dirty' || status === 'saving' || status === 'error'
              ? save(true)
              : start(() => router.push(`${base}/notes/${slugRef.current}`))
          }
        >
          Done
        </Button>
      </div>
      {lite ? (
        <textarea
          className={s.liteEditor}
          aria-label="Note body"
          dir="auto"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            scheduleSave();
          }}
          placeholder="Write in Markdown. [[wiki links]] and $TeX$ work."
        />
      ) : (
        <div className={s.split}>
          <MarkdownEditor
            value={body}
            onChange={(v) => {
              setBody(v);
              scheduleSave();
            }}
            linkTargets={linkTargets}
            macros={macros}
            onSave={() => save(false)}
            autoFocus
          />
          <div className={s.preview}>
            <MarkdownView html={html} />
          </div>
        </div>
      )}
    </div>
  );
}
