'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { SessionKind } from '@quire/shared';
import {
  Download,
  FileText,
  FolderInput,
  Pencil,
  Plus,
  Presentation,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type DragEvent, useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  type ActionState,
  createSessionAction,
  deleteSessionAction,
  dropSessionFilesAction,
  updateSessionAction,
} from '@/app/actions/sessions';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import type { Document, Session } from '@/db/schema';
import type { SessionWithDocuments } from '@/lib/sessions';
import { MoveDeckDialog } from './move-deck-dialog';
import s from './sessions.module.css';

const LABEL: Record<SessionKind, { one: string; many: string; tab: string }> = {
  lecture: { one: 'Lecture', many: 'Lectures', tab: 'lectures' },
  recitation: { one: 'Recitation', many: 'Recitations', tab: 'recitations' },
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

export function SessionsList({
  slug,
  kind,
  sessions,
  allSessions,
  lite = false,
}: {
  slug: string;
  kind: SessionKind;
  sessions: SessionWithDocuments[];
  /** Every session in the project (both kinds) — targets for the "move deck" picker. */
  allSessions: Session[];
  /** Phones: list only, no drop zone or inline editing. */
  lite?: boolean;
}) {
  const { base } = useProject();
  const router = useRouter();
  const label = LABEL[kind];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SessionWithDocuments | null>(null);
  const [moving, setMoving] = useState<{ doc: Document; sessionId: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropState, dropAction, dropping] = useActionState<ActionState, FormData>(dropSessionFilesAction, {});
  const [deleting, startDelete] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (dropState.ok) router.refresh();
  }, [dropState, router]);

  const submitFiles = (files: FileList | File[]) => {
    const form = formRef.current;
    const input = fileInput.current;
    if (!form || !input) return;
    const dt = new DataTransfer();
    for (const f of Array.from(files)) dt.items.add(f);
    input.files = dt.files;
    form.requestSubmit();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) submitFiles(e.dataTransfer.files);
  };
  const removeSession = (x: SessionWithDocuments) => {
    const name = x.title ? `${label.one} ${x.number} — ${x.title}` : `${label.one} ${x.number}`;
    if (!window.confirm(`Delete ${name}? Its decks stay in Documents and its notes stay in Notes.`)) return;
    startDelete(() => deleteSessionAction(slug, x.id));
  };

  return (
    <div
      className={s.wrap}
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (lite) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={lite ? undefined : onDrop}
      data-testid={`${kind}s-list`}
    >
      <header className={s.head}>
        <div>
          <h1 className={s.title}>{label.many}</h1>
          <p className={s.sub}>
            {lite
              ? `${sessions.length} ${sessions.length === 1 ? label.one.toLowerCase() : label.many.toLowerCase()}.`
              : `Drop decks here: each file becomes a ${label.one.toLowerCase()}, numbered and titled from its name.`}
          </p>
        </div>
        <div className={s.actions}>
          {!lite && (
            <Button
              variant="secondary"
              icon={<Icon icon={Upload} />}
              onClick={() => fileInput.current?.click()}
            >
              {dropping ? 'Uploading…' : 'Add decks'}
            </Button>
          )}
          <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
            {label.one}
          </Button>
        </div>
      </header>
      <form ref={formRef} action={dropAction} className={s.hiddenForm} aria-hidden="true">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="kind" value={kind} />
        <input
          ref={fileInput}
          type="file"
          name="files"
          multiple
          accept=".pdf,.pptx,.ppt,.key,.odp,application/pdf"
          onChange={(e) => e.currentTarget.files?.length && formRef.current?.requestSubmit()}
        />
      </form>
      {dropState.error && (
        <p role="alert" className={s.error} data-testid="drop-error">
          {dropState.error}
        </p>
      )}
      {dropping && <p className={s.progress}>Uploading and converting… large decks take a minute.</p>}
      {sessions.length === 0 ? (
        <EmptyState title={`No ${label.many.toLowerCase()} yet`}>
          {lite
            ? `Add ${label.many.toLowerCase()} from an iPad or laptop.`
            : `Drop a PDF or PowerPoint deck anywhere on this page, or add an empty ${label.one.toLowerCase()} and attach files later.`}
        </EmptyState>
      ) : (
        <ol className={s.list}>
          {sessions.map((x) => (
            <li key={x.id} className={s.row} data-testid="session-row">
              <div className={s.rowLine}>
                <NextLink href={`${base}/${label.tab}/${x.id}`} className={s.rowMain}>
                  <span className={s.num}>
                    <Icon icon={kind === 'lecture' ? Presentation : Users} />
                    {x.number}
                  </span>
                  <span className={s.rowText}>
                    <span className={s.rowTitle}>{x.title || `${label.one} ${x.number}`}</span>
                    <span className={s.rowMeta}>
                      {[
                        fmtDate(x.date),
                        x.documents.length === 0
                          ? 'no files'
                          : `${x.documents.length} file${x.documents.length === 1 ? '' : 's'}`,
                        x.documents.some((d) => d.conversionError) ? 'needs a PDF rendering' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </NextLink>
                {!lite && (
                  <span className={s.rowActions}>
                    <button
                      type="button"
                      className={s.iconBtn}
                      title={`Edit ${label.one.toLowerCase()} number, title and date`}
                      aria-label={`Edit ${x.title || `${label.one} ${x.number}`}`}
                      onClick={() => setEditing(x)}
                    >
                      <Icon icon={Pencil} />
                    </button>
                    <button
                      type="button"
                      className={s.iconBtn}
                      title={`Delete ${label.one.toLowerCase()}`}
                      aria-label={`Delete ${x.title || `${label.one} ${x.number}`}`}
                      disabled={deleting}
                      onClick={() => removeSession(x)}
                    >
                      <Icon icon={Trash2} />
                    </button>
                  </span>
                )}
              </div>
              {x.documents.length > 0 && (
                <ul className={s.rowDecks} data-testid="session-decks">
                  {x.documents.map((d) => (
                    <li key={d.id} className={s.deckTag}>
                      <span className={s.deckTagName} title={d.title}>
                        {d.title}
                      </span>
                      {d.originalPath ? (
                        <a
                          href={`/api/projects/${slug}/documents/${d.id}/original`}
                          className={s.deckDel}
                          title={`Download ${d.originalName ?? 'deck'}`}
                          aria-label={`Download ${d.originalName ?? 'deck'}`}
                        >
                          <Icon icon={Download} />
                        </a>
                      ) : d.filePath ? (
                        <a
                          href={`/api/projects/${slug}/documents/${d.id}/file?download=1`}
                          className={s.deckDel}
                          title={`Download ${d.title}`}
                          aria-label={`Download ${d.title}`}
                        >
                          <Icon icon={FileText} />
                        </a>
                      ) : null}
                      {!lite && (
                        <button
                          type="button"
                          className={s.deckDel}
                          title={`Move ${d.title} to another ${label.one.toLowerCase()}`}
                          aria-label={`Move ${d.title}`}
                          onClick={() => setMoving({ doc: d, sessionId: x.id })}
                        >
                          <Icon icon={FolderInput} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {dragging && !lite && <div className={s.dropHint}>Drop to add {label.many.toLowerCase()}</div>}
      <NewSessionDialog
        slug={slug}
        kind={kind}
        open={open}
        onClose={() => setOpen(false)}
        nextNumber={nextNumber(sessions)}
      />
      {editing && (
        <EditSessionDialog
          key={editing.id}
          slug={slug}
          kind={kind}
          session={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {moving && (
        <MoveDeckDialog
          key={moving.doc.id}
          slug={slug}
          doc={{ id: moving.doc.id, title: moving.doc.title }}
          sessions={allSessions}
          currentSessionId={moving.sessionId}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

function EditSessionDialog({
  slug,
  kind,
  session,
  onClose,
}: {
  slug: string;
  kind: SessionKind;
  session: SessionWithDocuments;
  onClose: () => void;
}) {
  const router = useRouter();
  const label = LABEL[kind];
  const [number, setNumber] = useState(String(session.number));
  const [title, setTitle] = useState(session.title);
  const [date, setDate] = useState(session.date ?? '');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError('');
      const res = await updateSessionAction(slug, session.id, {
        number: Number(number),
        title: title.trim(),
        date: date || null,
      });
      if (res.error) setError(res.error);
      else {
        router.refresh();
        onClose();
      }
    });

  return (
    <Dialog open title={`Edit ${label.one.toLowerCase()}`} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className={s.formRow}>
          <Field label="Number">
            <Input
              type="number"
              min={0}
              max={999}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              required
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Title" error={error} hint="The topic, e.g. SIMD.">
          <Input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

const nextNumber = (sessions: SessionWithDocuments[]) =>
  sessions.reduce((m, x) => Math.max(m, x.number), 0) + 1;

function NewSessionDialog({
  slug,
  kind,
  open,
  onClose,
  nextNumber,
}: {
  slug: string;
  kind: SessionKind;
  open: boolean;
  onClose: () => void;
  nextNumber: number;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createSessionAction, {});
  const label = LABEL[kind];
  return (
    <Dialog open={open} title={`New ${label.one.toLowerCase()}`} onClose={onClose}>
      <form action={action} className={s.form}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="kind" value={kind} />
        <div className={s.formRow}>
          <Field label="Number">
            <Input name="number" type="number" min={0} max={999} defaultValue={nextNumber} required />
          </Field>
          <Field label="Date">
            <Input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
          </Field>
        </div>
        <Field label="Title" error={state.error} hint="Optional; the topic, e.g. SIMD.">
          <Input name="title" maxLength={200} autoFocus />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : `Create ${label.one.toLowerCase()}`}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
