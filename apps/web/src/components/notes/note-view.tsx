'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ArrowUpRight, Check, Pencil, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  deleteNoteAction,
  followWikiLinkAction,
  promoteNoteAction,
  updateNoteAction,
} from '@/app/actions/notes';
import { MarkdownView } from '@/components/documents/markdown-view';
import { MarkdownEditor } from '@/components/editor/markdown-editor';
import type { Note } from '@/db/schema';
import { renderMarkdownClient } from '@/lib/markdown-client';
import type { Backlink } from '@/lib/notes';
import s from './notes.module.css';

export function NoteView({
  slug,
  note,
  html,
  backlinks,
  unresolved,
  linkTargets,
  editing,
}: {
  slug: string;
  note: Note;
  html: string;
  backlinks: Backlink[];
  unresolved: string[];
  linkTargets: string[];
  editing: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const follow = useCallback((name: string) => start(() => followWikiLinkAction(slug, name)), [slug]);

  if (editing) return <NoteEditor slug={slug} note={note} linkTargets={linkTargets} />;

  return (
    <div className={s.main}>
      <div className={s.bar}>
        <h1 className={s.title}>{note.title}</h1>
        <span className={s.status}>
          edited {note.updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
        <NextLink href={`/p/${slug}/notes/${note.slug}?edit=1`} className={s.chip}>
          <Icon icon={Pencil} /> Edit
        </NextLink>
        <button
          type="button"
          className={s.chip}
          disabled={pending}
          onClick={() => start(() => promoteNoteAction(slug, note.id))}
          title="Turn this note into a Markdown document"
        >
          <Icon icon={ArrowUpRight} /> Promote to document
        </button>
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
                    b.fromKind === 'note'
                      ? `/p/${slug}/notes/${b.fromId}`
                      : `/p/${slug}/documents/${b.fromId}`
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

function NoteEditor({ slug, note, linkTargets }: { slug: string; note: Note; linkTargets: string[] }) {
  const router = useRouter();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [html, setHtml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      renderMarkdownClient(body).then(setHtml);
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body]);

  const save = useCallback(
    (thenClose = false) =>
      start(async () => {
        const res = await updateNoteAction(slug, note.id, { title, body });
        if (res.error) return;
        setDirty(false);
        const target = `/p/${slug}/notes/${res.noteSlug ?? note.slug}`;
        if (thenClose) router.push(target);
        else if (res.noteSlug && res.noteSlug !== note.slug) router.replace(`${target}?edit=1`);
        else router.refresh();
      }),
    [slug, note.id, note.slug, title, body, router],
  );

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  return (
    <div className={s.main}>
      <div className={s.bar}>
        <input
          className={s.titleInput}
          aria-label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
        <span className={s.status}>{pending ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
        <Button variant="secondary" size="sm" disabled={pending || !dirty} onClick={() => save(false)}>
          Save
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Icon icon={Check} />}
          disabled={pending}
          onClick={() => (dirty ? save(true) : router.push(`/p/${slug}/notes/${note.slug}`))}
        >
          Done
        </Button>
      </div>
      <div className={s.split}>
        <MarkdownEditor
          value={body}
          onChange={(v) => {
            setBody(v);
            setDirty(true);
          }}
          linkTargets={linkTargets}
          onSave={() => save(false)}
          autoFocus
        />
        <div className={s.preview}>
          <MarkdownView html={html} />
        </div>
      </div>
    </div>
  );
}
