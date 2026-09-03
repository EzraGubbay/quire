'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { SOURCE_TYPES, type SourceType } from '@quire/shared';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import { type ActionState, deleteSourceAction, saveSourceAction } from '@/app/actions/sources';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { Source } from '@/db/schema';
import s from './sources.module.css';

const TYPE_LABEL: Record<SourceType, string> = {
  web: 'Web page',
  book: 'Book',
  video: 'Video',
  dataset: 'Dataset',
  repo: 'Repository',
  post: 'Post',
  other: 'Other',
};

export function SourcesView({ slug, sources }: { slug: string; sources: Source[] }) {
  const router = useRouter();
  const [type, setType] = useState<'all' | SourceType>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const [, start] = useTransition();
  const allTags = useMemo(() => [...new Set(sources.flatMap((x) => x.tags))].sort(), [sources]);
  const visible = sources.filter(
    (x) => (type === 'all' || x.type === type) && (!tag || x.tags.includes(tag)),
  );
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <h1 className={s.title}>Sources</h1>
        <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setEditing('new')}>
          Add source
        </Button>
      </div>
      <div className={s.filters}>
        <button type="button" className={s.chip} data-active={type === 'all'} onClick={() => setType('all')}>
          Any type
        </button>
        {SOURCE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={s.chip}
            data-active={type === t}
            onClick={() => setType(t)}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
        {allTags.length > 0 && <span style={{ width: 8 }} />}
        {allTags.map((t) => (
          <button
            key={t}
            type="button"
            className={s.chip}
            data-active={tag === t}
            onClick={() => setTag((v) => (v === t ? null : t))}
          >
            #{t}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className={s.muted}>
          {sources.length === 0
            ? 'No sources yet. Web pages, books, videos, datasets, repos: anything worth keeping track of.'
            : 'Nothing matches these filters.'}
        </p>
      ) : (
        <div className={s.grid}>
          {visible.map((x) => (
            <article key={x.id} className={s.card} data-testid="source-card">
              <div className={s.cardHead}>
                <span className={s.type}>{TYPE_LABEL[x.type]}</span>
                {x.snapshotAt && (
                  <span className={s.snap} title="Page text captured for search and AI">
                    snapshot
                  </span>
                )}
                <span className={s.actions}>
                  {x.url && (
                    <a
                      className={s.iconBtn}
                      href={x.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open link"
                    >
                      <Icon icon={ExternalLink} />
                    </a>
                  )}
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Edit ${x.title}`}
                    onClick={() => setEditing(x)}
                  >
                    <Icon icon={Pencil} />
                  </button>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Delete ${x.title}`}
                    onClick={() => {
                      if (window.confirm(`Delete "${x.title}"?`))
                        start(async () => {
                          await deleteSourceAction(slug, x.id);
                          router.refresh();
                        });
                    }}
                  >
                    <Icon icon={Trash2} />
                  </button>
                </span>
              </div>
              {x.url ? (
                <a className={s.cardTitle} href={x.url} target="_blank" rel="noreferrer">
                  {x.title}
                </a>
              ) : (
                <span className={s.cardTitle}>{x.title}</span>
              )}
              {x.url && <span className={s.host}>{safeHost(x.url)}</span>}
              {x.description && <p className={s.desc}>{x.description}</p>}
              {x.tags.length > 0 && (
                <div className={s.tags}>
                  {x.tags.map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {editing && (
        <SourceDialog
          slug={slug}
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function SourceDialog({
  slug,
  source,
  onClose,
}: {
  slug: string;
  source: Source | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSourceAction, {});
  useEffect(() => {
    if (state.ok) {
      onClose();
      router.refresh();
    }
  }, [state.ok, onClose, router]);
  return (
    <Dialog open title={source ? 'Edit source' : 'Add source'} onClose={onClose}>
      <form action={action} className={s.form}>
        <input type="hidden" name="slug" value={slug} />
        {source && <input type="hidden" name="id" value={source.id} />}
        <Field label="URL" hint="Optional for books and offline sources.">
          <Input
            name="url"
            type="url"
            defaultValue={source?.url ?? ''}
            placeholder="https://…"
            autoFocus={!source}
          />
        </Field>
        <Field
          label="Title"
          hint={source ? undefined : 'Leave empty to take the page title.'}
          error={state.error}
        >
          <Input name="title" defaultValue={source?.title ?? ''} maxLength={300} />
        </Field>
        <div className={s.row}>
          <Field label="Type">
            <select name="type" className={s.chip} defaultValue={source?.type ?? 'web'}>
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tags" hint="Comma separated">
            <Input
              name="tags"
              defaultValue={source?.tags.join(', ') ?? ''}
              placeholder="routing, baselines"
            />
          </Field>
        </div>
        <Field label="Description">
          <Textarea name="description" defaultValue={source?.description ?? ''} rows={3} />
        </Field>
        <label className={s.check}>
          <input type="checkbox" name="snapshot" defaultChecked={!source} /> Capture the page text for search
          and AI
        </label>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : source ? 'Save' : 'Add source'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
