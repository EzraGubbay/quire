'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Plus, Waypoints } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useMemo, useState } from 'react';
import { type ActionState, createNoteAction } from '@/app/actions/notes';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import type { Note } from '@/db/schema';
import { fuzzyScore } from '@/lib/fuzzy';
import s from './notes.module.css';

export function NotesRail({
  slug,
  notes,
  activeSlug,
  openNew = false,
  phone = false,
}: {
  slug: string;
  notes: Note[];
  activeSlug?: string;
  openNew?: boolean;
  /** Full-page list on phones. */
  phone?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(openNew);
  const [state, action, pending] = useActionState<ActionState, FormData>(createNoteAction, {});
  const visible = useMemo(() => {
    if (!query.trim()) return notes;
    return notes
      .map((n) => ({
        n,
        score: Math.max(fuzzyScore(query, n.title) * 2, fuzzyScore(query, n.body.slice(0, 2000))),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.n);
  }, [notes, query]);
  return (
    <aside className={s.rail} aria-label="Notes" data-phone={phone ? 'true' : undefined}>
      <div className={s.railHead}>
        <h2 className={s.railTitle}>Notes · {notes.length}</h2>
        <div style={{ display: 'flex', gap: 2 }}>
          {!phone && (
            <NextLink href={`/p/${slug}/notes/graph`} aria-label="Graph" title="Graph" className={s.iconLink}>
              <Icon icon={Waypoints} />
            </NextLink>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="New note"
            icon={<Icon icon={Plus} />}
            onClick={() => setOpen(true)}
          />
        </div>
      </div>
      <input
        className={s.search}
        type="search"
        placeholder="Search notes"
        aria-label="Search notes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={s.list}>
        {visible.length === 0 ? (
          <p className={s.itemMeta} style={{ padding: 10 }}>
            {notes.length === 0 ? 'No notes yet.' : 'No matches.'}
          </p>
        ) : (
          visible.map((n) => (
            <NextLink
              key={n.id}
              href={`/p/${slug}/notes/${n.slug}`}
              className={s.item}
              data-active={n.slug === activeSlug}
            >
              <span className={s.itemTitle}>{n.title}</span>
              <span className={s.itemMeta}>
                {n.updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
            </NextLink>
          ))
        )}
      </div>
      <Dialog open={open} title="New note" onClose={() => setOpen(false)}>
        <form action={action} className={s.form}>
          <input type="hidden" name="slug" value={slug} />
          <Field label="Title" error={state.error}>
            <Input name="title" required maxLength={200} autoFocus placeholder="ELBO tightness" />
          </Field>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Create note
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </aside>
  );
}
