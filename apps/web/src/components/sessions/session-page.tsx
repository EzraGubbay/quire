'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { SessionKind } from '@quire/shared';
import { ArrowLeft, FolderInput, Trash2, Upload } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { type ActionState, deleteDeckAction, dropSessionFilesAction } from '@/app/actions/sessions';
import { DocumentView } from '@/components/documents/document-view';
import { useProject } from '@/components/project-context';
import { EmptyState } from '@/components/ui/empty-state';
import type { Annotation, Document, Note, Session } from '@/db/schema';
import type { SessionWithDocuments } from '@/lib/sessions';
import { MoveDeckDialog } from './move-deck-dialog';
import { SessionNotePane } from './session-note-pane';
import s from './sessions.module.css';

const TAB: Record<SessionKind, string> = { lecture: 'lectures', recitation: 'recitations' };
const LABEL: Record<SessionKind, string> = { lecture: 'Lecture', recitation: 'Recitation' };

export function SessionPage({
  slug,
  session,
  sessions,
  doc,
  annotations,
  note,
  linkTargets,
  macros,
  split,
  canAnnotate,
  lite,
  platform,
  canSynthesize,
}: {
  slug: string;
  session: SessionWithDocuments;
  /** Every session in the project — targets for the "move deck" picker. */
  sessions: Session[];
  /** The deck shown; null when the session has no file yet. */
  doc: Document | null;
  annotations: Annotation[];
  note: Note | null;
  linkTargets: string[];
  macros: string[];
  /** Side-by-side note pane (feature sessions.split). */
  split: boolean;
  canAnnotate: boolean;
  lite: boolean;
  platform: 'phone' | 'tablet' | 'desktop';
  canSynthesize: boolean;
}) {
  const { base } = useProject();
  const router = useRouter();
  const [page, setPage] = useState(doc?.lastPage ?? 1);
  const [deleting, startDelete] = useTransition();
  const [moving, setMoving] = useState<Document | null>(null);
  const title = `${LABEL[session.kind]} ${session.number}${session.title ? ` — ${session.title}` : ''}`;
  const backHref = `${base}/${TAB[session.kind]}`;
  const deleteDeck = (d: Document) => {
    if (!window.confirm(`Delete the deck “${d.title}”? The file is removed; your notes stay.`)) return;
    startDelete(() => deleteDeckAction(slug, d.id));
  };
  if (!doc) return <NoDeck slug={slug} session={session} backHref={backHref} title={title} />;
  const aside = split
    ? {
        label: 'Note',
        onPage: setPage,
        node: (
          <SessionNotePane
            slug={slug}
            sessionId={session.id}
            note={note}
            deckTitle={doc.title}
            currentPage={page}
            linkTargets={linkTargets}
            macros={macros}
            canSynthesize={canSynthesize}
          />
        ),
      }
    : undefined;
  return (
    <div style={{ display: 'contents' }} data-testid="session-page">
      <div className={s.deckSwitch} data-testid="deck-switch">
        {session.documents.map((d) => (
          <span key={d.id} className={s.deckChipWrap} data-active={d.id === doc.id || undefined}>
            {session.documents.length > 1 ? (
              <NextLink
                href={`${backHref}/${session.id}?doc=${d.id}`}
                className={s.deckChip}
                data-active={d.id === doc.id || undefined}
              >
                {d.title}
              </NextLink>
            ) : (
              <span className={s.deckChip}>{d.title}</span>
            )}
            {!lite && (
              <button
                type="button"
                className={s.deckDel}
                title={`Move deck ${d.title} to another ${LABEL[session.kind].toLowerCase()}`}
                aria-label={`Move deck ${d.title}`}
                onClick={() => setMoving(d)}
              >
                <Icon icon={FolderInput} />
              </button>
            )}
            <button
              type="button"
              className={s.deckDel}
              disabled={deleting}
              title={`Delete deck ${d.title}`}
              aria-label={`Delete deck ${d.title}`}
              onClick={() => deleteDeck(d)}
            >
              <Icon icon={Trash2} />
            </button>
          </span>
        ))}
      </div>
      {moving && (
        <MoveDeckDialog
          slug={slug}
          doc={{ id: moving.id, title: moving.title }}
          sessions={sessions}
          currentSessionId={session.id}
          onClose={() => setMoving(null)}
        />
      )}
      <DocumentView
        key={doc.id}
        slug={slug}
        document={doc}
        annotations={annotations}
        html=""
        linkTargets={linkTargets}
        canAnnotate={canAnnotate}
        lite={lite}
        platform={platform}
        aside={aside}
        backHref={backHref}
        backLabel={`${LABEL[session.kind]}s`}
      />
      {!split && note && (
        <NextLink href={`${base}/notes/${note.slug}`} className={s.noteLink}>
          Open the raw note
        </NextLink>
      )}
      {!split && !note && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => router.push(`${base}/notes?new=1`)}
          className={s.noteLink}
        >
          Take notes
        </Button>
      )}
    </div>
  );
}

function NoDeck({
  slug,
  session,
  backHref,
  title,
}: {
  slug: string;
  session: SessionWithDocuments;
  backHref: string;
  title: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(dropSessionFilesAction, {});
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <div>
          <NextLink href={backHref} className={s.back}>
            <Icon icon={ArrowLeft} /> {LABEL[session.kind]}s
          </NextLink>
          <h1 className={s.title}>{title}</h1>
        </div>
      </div>
      <form ref={form} action={action} className={s.hiddenForm}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="kind" value={session.kind} />
        <input type="hidden" name="sessionId" value={session.id} />
        <input
          ref={input}
          type="file"
          name="files"
          multiple
          accept=".pdf,.pptx,.ppt,.key,.odp,application/pdf"
          onChange={() => form.current?.requestSubmit()}
        />
      </form>
      <EmptyState
        title="No deck yet"
        actions={
          <Button
            variant="primary"
            icon={<Icon icon={Upload} />}
            disabled={pending}
            onClick={() => input.current?.click()}
          >
            {pending ? 'Uploading…' : 'Attach a deck (PDF or PPTX)'}
          </Button>
        }
      >
        {state.error ?? 'Attach the slides to read them here beside your notes.'}
      </EmptyState>
    </div>
  );
}
