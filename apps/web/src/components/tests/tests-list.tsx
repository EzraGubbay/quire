'use client';

import { Button, Card, CardRow, Icon } from '@ezragubbay/folio';
import { PRACTICE_EXAMS_REQUIRED } from '@quire/shared';
import { GraduationCap, ListChecks, Sparkles } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { estimateTestAction, startTestAction } from '@/app/actions/tests';
import { useProject } from '@/components/project-context';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PollWhile } from '@/components/ui/poll-while';
import type { Session, Test } from '@/db/schema';
import type { TestEstimate } from '@/lib/ai/tests';
import s from './tests.module.css';

const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function TestsList({
  slug,
  tests,
  sessions,
  practiceExams,
  weeksSinceTriweekly,
  canGenerate,
}: {
  slug: string;
  tests: Test[];
  sessions: Session[];
  practiceExams: number;
  weeksSinceTriweekly: number | null;
  canGenerate: boolean;
}) {
  const { base } = useProject();
  const router = useRouter();
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [triOpen, setTriOpen] = useState(false);
  const generating = tests.some((t) => t.status === 'generating');
  const triReady = practiceExams >= PRACTICE_EXAMS_REQUIRED;
  const nudge = triReady && (weeksSinceTriweekly === null || weeksSinceTriweekly >= 3);
  return (
    <div className={s.wrap} data-testid="tests-list">
      <PollWhile active={generating} />
      <header className={s.head}>
        <div>
          <h1 className={s.title}>Tests</h1>
          <p className={s.sub}>
            Generated from your notes and slides, taken on paper, marked by you. Failed questions become a
            re-read list.
          </p>
        </div>
      </header>
      {canGenerate && (
        <div className={s.generators}>
          <Card title="Weekly test" action={<Icon icon={ListChecks} />}>
            <p className={s.muted}>
              Recall of specific lectures or recitations. Dry questions are fine; the point is to trigger
              memory.
            </p>
            <div>
              <Button
                variant="primary"
                size="sm"
                icon={<Icon icon={Sparkles} />}
                onClick={() => setWeeklyOpen(true)}
                disabled={sessions.length === 0}
              >
                Weekly test
              </Button>
              {sessions.length === 0 && <span className={s.hint}> Add a lecture first.</span>}
            </div>
          </Card>
          <Card title="Tri-weekly test" action={<Icon icon={GraduationCap} />}>
            <p className={s.muted}>
              Exam style and difficulty over everything so far, modelled on the practice exams without copying
              them.
            </p>
            <div>
              <Button
                variant="primary"
                size="sm"
                icon={<Icon icon={Sparkles} />}
                onClick={() => setTriOpen(true)}
                disabled={!triReady}
                title={
                  triReady
                    ? undefined
                    : `Needs ${PRACTICE_EXAMS_REQUIRED} practice exams in Documents › Practice Exams`
                }
              >
                Tri-weekly test
              </Button>
              <span className={s.hint} data-testid="practice-count">
                {' '}
                {practiceExams}/{PRACTICE_EXAMS_REQUIRED} practice exams
                {!triReady && (
                  <>
                    {' · '}
                    <NextLink href={`${base}/documents`}>add them in Documents</NextLink>
                  </>
                )}
              </span>
              {nudge && (
                <p className={s.nudge}>
                  {weeksSinceTriweekly === null
                    ? 'No tri-weekly test yet.'
                    : `${weeksSinceTriweekly} weeks since the last one.`}
                </p>
              )}
            </div>
          </Card>
        </div>
      )}
      {tests.length === 0 ? (
        <EmptyState title="No tests yet">
          {canGenerate
            ? 'Generate a weekly test from the lectures you want to rehearse.'
            : 'Tests are generated on an iPad or laptop; past tests appear here.'}
        </EmptyState>
      ) : (
        <Card title="History" action={<span className={s.hint}>{tests.length}</span>}>
          {tests.map((t) => (
            <CardRow
              key={t.id}
              icon={<Icon icon={t.kind === 'weekly' ? ListChecks : GraduationCap} />}
              title={<NextLink href={`${base}/tests/${t.id}`}>{t.title}</NextLink>}
              meta={[
                t.kind === 'weekly' ? 'weekly' : 'tri-weekly',
                t.status === 'generating'
                  ? 'generating…'
                  : t.status === 'failed'
                    ? 'failed'
                    : t.status === 'marked'
                      ? 'marked'
                      : 'ready to take',
                fmt(t.createdAt),
              ].join(' · ')}
            />
          ))}
        </Card>
      )}
      <GenerateDialog
        slug={slug}
        kind="weekly"
        sessions={sessions}
        open={weeklyOpen}
        onClose={() => setWeeklyOpen(false)}
        onStarted={(id) => router.push(`${base}/tests/${id}`)}
      />
      <GenerateDialog
        slug={slug}
        kind="triweekly"
        sessions={[]}
        open={triOpen}
        onClose={() => setTriOpen(false)}
        onStarted={(id) => router.push(`${base}/tests/${id}`)}
      />
    </div>
  );
}

function GenerateDialog({
  slug,
  kind,
  sessions,
  open,
  onClose,
  onStarted,
}: {
  slug: string;
  kind: 'weekly' | 'triweekly';
  sessions: Session[];
  open: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<TestEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = [...picked];
  useEffect(() => {
    if (!open) return;
    setError(null);
    // Default: the most recent lecture.
    const latest = [...sessions].filter((x) => x.kind === 'lecture').sort((a, b) => b.number - a.number)[0];
    setPicked(new Set(latest ? [latest.id] : []));
  }, [open, sessions]);
  useEffect(() => {
    if (!open) return;
    if (kind === 'weekly' && ids.length === 0) {
      setEstimate(null);
      return;
    }
    setEstimate(null);
    estimateTestAction(slug, kind, ids)
      .then(setEstimate)
      .catch((e: Error) => setError(e.message));
    // biome-ignore lint/correctness/useExhaustiveDependencies: ids is derived from picked; the joined key is the trigger
  }, [open, kind, slug, ids.join(',')]);
  const submit = () =>
    start(async () => {
      const res = await startTestAction(slug, kind, ids);
      if (res.error || !res.testId) {
        setError(res.error ?? 'Could not start');
        return;
      }
      onClose();
      onStarted(res.testId);
    });
  return (
    <Dialog open={open} title={kind === 'weekly' ? 'Weekly test' : 'Tri-weekly test'} onClose={onClose}>
      <div className={s.form}>
        {kind === 'weekly' ? (
          <fieldset className={s.fieldset}>
            <legend className={s.legend}>Sessions to cover</legend>
            <div className={s.picker}>
              {sessions.map((x) => (
                <label key={x.id} className={s.pick} data-active={picked.has(x.id)}>
                  <input
                    type="checkbox"
                    checked={picked.has(x.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(x.id);
                      else next.delete(x.id);
                      setPicked(next);
                    }}
                  />
                  <span>
                    {x.kind === 'lecture' ? 'Lecture' : 'Recitation'} {x.number}
                    {x.title ? ` — ${x.title}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className={s.muted}>
            Covers every lecture and recitation so far. Uses your synthesized notes (raw where none), the
            slides of sessions without notes, the practice exams and your homework feedback.
          </p>
        )}
        <p className={s.estimate} data-testid="test-estimate">
          {error
            ? error
            : estimate
              ? `${estimate.model} · about $${estimate.costUsd.toFixed(2)} (${Math.round(estimate.inputTokens / 1000)}k tokens in). The test appears in a minute or two; you take it on paper or in a pen app, then mark it here.`
              : kind === 'weekly' && ids.length === 0
                ? 'Pick at least one session.'
                : 'Estimating…'}
        </p>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" disabled={pending || !estimate} onClick={submit}>
            {pending ? 'Starting…' : 'Generate'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
