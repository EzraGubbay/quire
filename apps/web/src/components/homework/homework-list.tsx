'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ClipboardList, Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useState } from 'react';
import { type ActionState, createAssignmentAction } from '@/app/actions/homework';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { AssignmentWithProgress } from '@/lib/homework';
import s from './homework.module.css';

export const STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  graded: 'Graded',
} as const;

export function dueBadge(
  dueAt: Date | null,
  status: string,
): { label: string; tone: 'overdue' | 'soon' | 'ok' | 'done' } | null {
  if (!dueAt) return null;
  if (status === 'submitted' || status === 'graded') return { label: 'done', tone: 'done' };
  const ms = dueAt.getTime() - Date.now();
  if (ms < 0) return { label: 'overdue', tone: 'overdue' };
  if (ms < 3 * 86_400_000)
    return { label: `due in ${Math.max(1, Math.round(ms / 86_400_000))}d`, tone: 'soon' };
  return { label: `due in ${Math.round(ms / 86_400_000)}d`, tone: 'ok' };
}

const fmt = (d: Date) =>
  d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function HomeworkList({ slug, assignments }: { slug: string; assignments: AssignmentWithProgress[] }) {
  const { base } = useProject();
  const [open, setOpen] = useState(false);
  const nextNumber = assignments.reduce((m, a) => Math.max(m, a.number), 0) + 1;
  const sorted = [...assignments].sort((a, b) => {
    const done = (x: AssignmentWithProgress) => (x.status === 'submitted' || x.status === 'graded' ? 1 : 0);
    if (done(a) !== done(b)) return done(a) - done(b);
    const ta = a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta - tb || a.number - b.number;
  });
  return (
    <div className={s.wrap} data-testid="homework-list">
      <header className={s.head}>
        <div>
          <h1 className={s.title}>Homework</h1>
          <p className={s.sub}>
            Track each assignment: the sheet, your question checklist, what you submitted, and the grade.
          </p>
        </div>
        <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
          Assignment
        </Button>
      </header>
      {sorted.length === 0 ? (
        <EmptyState title="No assignments yet">
          Add the first one with its due date; attach the problem sheet on its page.
        </EmptyState>
      ) : (
        <ol className={s.list}>
          {sorted.map((a) => {
            const badge = dueBadge(a.dueAt, a.status);
            const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
            return (
              <li key={a.id} className={s.row} data-status={a.status}>
                <NextLink href={`${base}/homework/${a.id}`} className={s.rowMain}>
                  <span className={s.num}>
                    <Icon icon={ClipboardList} /> #{a.number}
                  </span>
                  <span className={s.rowText}>
                    <span className={s.rowTitle}>{a.title}</span>
                    <span className={s.rowMeta}>
                      {[
                        a.dueAt ? fmt(a.dueAt) : 'no due date',
                        a.total ? `${a.done}/${a.total} questions` : null,
                        a.score != null ? `${a.score}${a.maxScore ? ` / ${a.maxScore}` : ''}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {a.total > 0 && (
                      <span className={s.progress} aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    )}
                  </span>
                </NextLink>
                <span className={s.rowRight}>
                  {badge && (
                    <span className={s.badge} data-tone={badge.tone}>
                      {badge.label}
                    </span>
                  )}
                  <span className={s.pill} data-status={a.status}>
                    {STATUS_LABEL[a.status]}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <NewAssignmentDialog slug={slug} open={open} onClose={() => setOpen(false)} nextNumber={nextNumber} />
    </div>
  );
}

function NewAssignmentDialog({
  slug,
  open,
  onClose,
  nextNumber,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  nextNumber: number;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createAssignmentAction, {});
  return (
    <Dialog open={open} title="New assignment" onClose={onClose}>
      <form action={action} className={s.form}>
        <input type="hidden" name="slug" value={slug} />
        <div className={s.formRow}>
          <Field label="Number">
            <Input name="number" type="number" min={0} max={999} defaultValue={nextNumber} required />
          </Field>
          <Field label="Due">
            <Input name="dueAt" type="datetime-local" />
          </Field>
        </div>
        <Field label="Title" error={state.error}>
          <Input name="title" required maxLength={200} autoFocus placeholder="OpenMP reductions" />
        </Field>
        <Field label="Questions" hint="Optional, one per line (Q1, Q2a, …). You can add more later.">
          <Textarea name="questions" placeholder={'Q1\nQ2a\nQ2b\nQ3'} />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create assignment'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
