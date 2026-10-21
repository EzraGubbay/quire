'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { QuestionStatus } from '@quire/shared';
import { ArrowLeft, FileText, MessageSquare, Paperclip, Plus, Trash2, Upload, X } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  type ActionState,
  addQuestionAction,
  attachAssignmentPdfAction,
  deleteAssignmentAction,
  deleteQuestionAction,
  removeSubmissionAction,
  updateAssignmentAction,
  updateQuestionAction,
  uploadSubmissionAction,
} from '@/app/actions/homework';
import { useProject } from '@/components/project-context';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { AssignmentQuestion } from '@/db/schema';
import type { AssignmentDetail } from '@/lib/homework';
import s from './homework.module.css';
import { dueBadge, STATUS_LABEL } from './homework-list';

const Q_STATUS: { value: QuestionStatus; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'working', label: 'Working' },
  { value: 'done', label: 'Done' },
  { value: 'stuck', label: 'Stuck' },
];
const nextStatus = (s: QuestionStatus): QuestionStatus =>
  s === 'todo' ? 'working' : s === 'working' ? 'done' : s === 'done' ? 'stuck' : 'todo';

const toLocalInput = (d: Date | null) => {
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function AssignmentView({ slug, assignment: a }: { slug: string; assignment: AssignmentDetail }) {
  const { base } = useProject();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newLabel, setNewLabel] = useState('');
  const badge = dueBadge(a.dueAt, a.status);
  const done = a.questions.filter((q) => q.status === 'done').length;
  const refresh = () => router.refresh();
  const patch = (p: Parameters<typeof updateAssignmentAction>[2]) =>
    start(async () => {
      await updateAssignmentAction(slug, a.id, p);
      refresh();
    });
  const ask = (q?: AssignmentQuestion) =>
    window.dispatchEvent(
      new CustomEvent('quire:ask', {
        detail: {
          documentId: a.sheetDocumentId ?? undefined,
          documentTitle: a.sheet?.title ?? `#${a.number} ${a.title}`,
          mode: 'tutor-hint',
          questionId: q?.id,
          questionLabel: q ? `${a.title} · ${q.label}` : a.title,
        },
      }),
    );
  return (
    <div className={s.wrap} data-testid="assignment-view">
      <div className={s.bar}>
        <NextLink href={`${base}/homework`} className={s.back}>
          <Icon icon={ArrowLeft} /> Homework
        </NextLink>
        <h1 className={s.title} style={{ fontSize: 22 }}>
          #{a.number} {a.title}
        </h1>
        {badge && (
          <span className={s.badge} data-tone={badge.tone}>
            {badge.label}
          </span>
        )}
        <select
          className={s.select}
          aria-label="Status"
          value={a.status}
          onChange={(e) => patch({ status: e.target.value as AssignmentDetail['status'] })}
          disabled={pending}
        >
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={s.chip}
          onClick={() => ask()}
          title="Ask the tutor about this assignment (hints by default)"
        >
          <Icon icon={MessageSquare} /> Ask tutor
        </button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={Trash2} />}
          aria-label="Delete assignment"
          onClick={() => {
            if (window.confirm(`Delete "${a.title}" and its files?`))
              start(() => deleteAssignmentAction(slug, a.id));
          }}
        >
          Delete
        </Button>
      </div>
      <div className={s.grid}>
        <section className={s.card}>
          <h2 className={s.h2}>Details</h2>
          <div className={s.formRow}>
            <Field label="Due">
              <Input
                type="datetime-local"
                defaultValue={toLocalInput(a.dueAt)}
                onBlur={(e) => patch({ dueAt: e.target.value || null })}
              />
            </Field>
            <Field label="Number">
              <Input
                type="number"
                min={0}
                defaultValue={a.number}
                onBlur={(e) => patch({ number: Number(e.target.value) || a.number })}
              />
            </Field>
          </div>
          <Field label="Title">
            <Input
              defaultValue={a.title}
              maxLength={200}
              onBlur={(e) =>
                e.target.value.trim() && e.target.value !== a.title && patch({ title: e.target.value })
              }
            />
          </Field>
          <Field label="Working notes" hint="Markdown and $math$. For yourself; not sent anywhere.">
            <Textarea
              defaultValue={a.notes}
              dir="auto"
              onBlur={(e) => e.target.value !== a.notes && patch({ notes: e.target.value })}
            />
          </Field>
        </section>

        <section className={s.card}>
          <h2 className={s.h2}>Problem sheet</h2>
          {a.sheet ? (
            <p className={s.fileRow}>
              <Icon icon={FileText} />
              <NextLink href={`${base}/documents/${a.sheet.id}`}>{a.sheet.title}</NextLink>
              <span className={s.hint}>annotatable in Documents › Homework</span>
            </p>
          ) : (
            <p className={s.muted}>No sheet attached.</p>
          )}
          <AttachPdf
            slug={slug}
            assignmentId={a.id}
            which="sheet"
            label={a.sheet ? 'Replace sheet (PDF)' : 'Attach sheet (PDF)'}
          />
        </section>

        <section className={`${s.card} ${s.wide}`}>
          <div className={s.cardHead}>
            <h2 className={s.h2}>Questions</h2>
            <span className={s.hint}>
              {done}/{a.questions.length} done
            </span>
          </div>
          {a.questions.length === 0 && (
            <p className={s.muted}>Add the questions on the sheet (Q1, Q2a, …) to track them one by one.</p>
          )}
          <ul className={s.questions}>
            {a.questions.map((q) => (
              <QuestionRow key={q.id} slug={slug} assignmentId={a.id} q={q} onAsk={() => ask(q)} />
            ))}
          </ul>
          <form
            className={s.addRow}
            onSubmit={(e) => {
              e.preventDefault();
              const label = newLabel;
              setNewLabel('');
              start(async () => {
                await addQuestionAction(slug, a.id, label);
                refresh();
              });
            }}
          >
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Q4b"
              maxLength={80}
              aria-label="New question label"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              icon={<Icon icon={Plus} />}
              disabled={!newLabel.trim() || pending}
            >
              Add question
            </Button>
          </form>
        </section>

        <section className={s.card}>
          <h2 className={s.h2}>Submission</h2>
          <Field label="Repository" hint="For code assignments: the repo or commit you handed in.">
            <Input
              type="url"
              defaultValue={a.repoUrl ?? ''}
              placeholder="https://github.com/…"
              onBlur={(e) =>
                (e.target.value || '') !== (a.repoUrl ?? '') && patch({ repoUrl: e.target.value || null })
              }
            />
          </Field>
          {a.files.length > 0 && (
            <ul className={s.files}>
              {a.files.map((f) => (
                <li key={f.id} className={s.fileRow}>
                  <Icon icon={Paperclip} />
                  <a href={`/api/projects/${slug}/assignments/${a.id}/files/${f.id}`}>{f.name}</a>
                  <span className={s.hint}>{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Remove ${f.name}`}
                    onClick={() =>
                      start(async () => {
                        await removeSubmissionAction(slug, a.id, f.id);
                        refresh();
                      })
                    }
                  >
                    <Icon icon={X} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <UploadFiles slug={slug} assignmentId={a.id} />
        </section>

        <section className={s.card}>
          <h2 className={s.h2}>Grade & feedback</h2>
          <div className={s.formRow}>
            <Field label="Score">
              <Input
                type="number"
                step="0.5"
                min={0}
                defaultValue={a.score ?? ''}
                onBlur={(e) => patch({ score: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            <Field label="Out of">
              <Input
                type="number"
                step="0.5"
                min={0}
                defaultValue={a.maxScore ?? ''}
                placeholder="100"
                onBlur={(e) => patch({ maxScore: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="What I lost points on" hint="Feeds the tri-weekly tests, so be specific.">
            <Textarea
              defaultValue={a.lostPoints}
              dir="auto"
              onBlur={(e) => e.target.value !== a.lostPoints && patch({ lostPoints: e.target.value })}
            />
          </Field>
          {a.returned ? (
            <p className={s.fileRow}>
              <Icon icon={FileText} />
              <NextLink href={`${base}/documents/${a.returned.id}`}>{a.returned.title}</NextLink>
              <span className={s.hint}>graded paper</span>
            </p>
          ) : null}
          <AttachPdf
            slug={slug}
            assignmentId={a.id}
            which="returned"
            label={a.returned ? 'Replace graded PDF' : 'Attach graded PDF'}
          />
        </section>
      </div>
    </div>
  );
}

function QuestionRow({
  slug,
  assignmentId,
  q,
  onAsk,
}: {
  slug: string;
  assignmentId: string;
  q: AssignmentQuestion;
  onAsk: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notesOpen, setNotesOpen] = useState(Boolean(q.notes));
  const update = (p: Parameters<typeof updateQuestionAction>[3]) =>
    start(async () => {
      await updateQuestionAction(slug, assignmentId, q.id, p);
      router.refresh();
    });
  return (
    <li className={s.q} data-status={q.status} data-testid="assignment-question">
      <div className={s.qRow}>
        <button
          type="button"
          className={s.qStatus}
          data-status={q.status}
          title="Cycle status: to do → working → done → stuck"
          disabled={pending}
          onClick={() => update({ status: nextStatus(q.status) })}
        >
          {Q_STATUS.find((x) => x.value === q.status)?.label}
        </button>
        <span className={s.qLabel}>{q.label}</span>
        <button type="button" className={s.chip} onClick={() => setNotesOpen((o) => !o)}>
          {notesOpen ? 'Hide notes' : q.notes ? 'Notes' : 'Add notes'}
        </button>
        <button
          type="button"
          className={s.chip}
          onClick={onAsk}
          title="Ask the tutor about this question (hints by default)"
        >
          <Icon icon={MessageSquare} /> Ask
        </button>
        <button
          type="button"
          className={s.iconBtn}
          aria-label={`Delete ${q.label}`}
          onClick={() => {
            if (window.confirm(`Remove ${q.label}?`))
              start(async () => {
                await deleteQuestionAction(slug, assignmentId, q.id);
                router.refresh();
              });
          }}
        >
          <Icon icon={Trash2} />
        </button>
      </div>
      {notesOpen && (
        <Textarea
          className={s.qNotes}
          defaultValue={q.notes}
          dir="auto"
          placeholder="Working notes for this question: approach, partial results, where you are stuck. Markdown and $math$."
          onBlur={(e) => e.target.value !== q.notes && update({ notes: e.target.value })}
        />
      )}
    </li>
  );
}

function AttachPdf({
  slug,
  assignmentId,
  which,
  label,
}: {
  slug: string;
  assignmentId: string;
  which: 'sheet' | 'returned';
  label: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(attachAssignmentPdfAction, {});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} className={s.attach}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="hidden" name="which" value={which} />
      <input
        ref={input}
        type="file"
        name="file"
        accept="application/pdf,.pdf"
        className={s.hiddenInput}
        aria-label={label}
        onChange={() => input.current?.form?.requestSubmit()}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={<Icon icon={Upload} />}
        disabled={pending}
        onClick={() => input.current?.click()}
      >
        {pending ? 'Uploading…' : label}
      </Button>
      {state.error && <span className={s.error}>{state.error}</span>}
    </form>
  );
}

function UploadFiles({ slug, assignmentId }: { slug: string; assignmentId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(uploadSubmissionAction, {});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} className={s.attach}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input
        ref={input}
        type="file"
        name="files"
        multiple
        className={s.hiddenInput}
        aria-label="Submission files"
        onChange={() => input.current?.form?.requestSubmit()}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={<Icon icon={Upload} />}
        disabled={pending}
        onClick={() => input.current?.click()}
      >
        {pending ? 'Uploading…' : 'Add submitted files'}
      </Button>
      {state.error && <span className={s.error}>{state.error}</span>}
    </form>
  );
}
