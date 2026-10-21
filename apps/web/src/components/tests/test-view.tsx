'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { TestResult } from '@quire/shared';
import { ArrowLeft, Download, Eye, EyeOff, Printer, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteTestAction, finishMarkingAction, markQuestionAction } from '@/app/actions/tests';
import { MarkdownView } from '@/components/documents/markdown-view';
import { useProject } from '@/components/project-context';
import { PollWhile } from '@/components/ui/poll-while';
import { Segmented } from '@/components/ui/segmented';
import type { RereadItem, Test, TestQuestion } from '@/db/schema';
import { testScore } from '@/lib/test-score';
import { RereadList } from './reread-list';
import s from './tests.module.css';

const RESULTS: { value: TestResult; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'partial', label: 'Partial' },
  { value: 'fail', label: 'Fail' },
];

export function TestView({
  slug,
  test,
  questions,
  html,
  answerHtml,
  reread,
  rereadPending,
}: {
  slug: string;
  test: Test;
  questions: TestQuestion[];
  /** Rendered question bodies, by question id. */
  html: Record<string, string>;
  answerHtml: Record<string, string>;
  reread: RereadItem[];
  /** Marked but the re-read list has not arrived yet. */
  rereadPending: boolean;
}) {
  const { base } = useProject();
  const router = useRouter();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const score = testScore(questions);
  const allMarked = questions.length > 0 && questions.every((q) => q.result);
  const toggle = (id: string) =>
    setRevealed((r) => {
      const n = new Set(r);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className={s.wrap} data-testid="test-view">
      <PollWhile active={test.status === 'generating' || rereadPending} />
      <div className={s.bar}>
        <NextLink href={`${base}/tests`} className={s.back}>
          <Icon icon={ArrowLeft} /> Tests
        </NextLink>
        <h1 className={s.title} style={{ fontSize: 22 }}>
          {test.title}
        </h1>
        <span className={s.hint}>
          {test.kind === 'weekly' ? 'weekly' : 'tri-weekly'}
          {test.model ? ` · ${test.model}` : ''}
        </span>
        {test.status !== 'generating' && test.status !== 'failed' && (
          <>
            {test.pdfPath ? (
              <a href={`/api/projects/${slug}/tests/${test.id}/pdf?download=1`} className={s.chip}>
                <Icon icon={Download} /> PDF
              </a>
            ) : (
              <NextLink href={`${base}/tests/${test.id}/print`} className={s.chip} target="_blank">
                <Icon icon={Printer} /> Print view
              </NextLink>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={Trash2} />}
          aria-label="Delete test"
          onClick={() => {
            if (window.confirm('Delete this test and its marks?'))
              start(() => deleteTestAction(slug, test.id));
          }}
        >
          Delete
        </Button>
      </div>
      {test.status === 'generating' && (
        <div className={s.generating} aria-busy="true">
          <p className={s.muted}>Writing the test… this takes a minute or two. The page updates by itself.</p>
          <div className={s.skelLine} style={{ width: '70%' }} />
          <div className={s.skelLine} style={{ width: '90%' }} />
          <div className={s.skelLine} style={{ width: '55%' }} />
        </div>
      )}
      {test.status === 'failed' && (
        <div className={s.failed} role="alert">
          <strong>Generation failed.</strong> {test.error}
          <div>
            <NextLink href={`${base}/tests`}>Back to tests</NextLink>
          </div>
        </div>
      )}
      {(test.status === 'ready' || test.status === 'marked') && (
        <>
          <p className={s.muted}>
            {test.status === 'ready'
              ? 'Take the test on paper or in a pen app from the PDF. Then reveal each model answer and mark yourself.'
              : score
                ? `Marked: ${score.got} / ${score.total} points.`
                : 'Marked.'}
          </p>
          <ol className={s.questions}>
            {questions.map((q) => (
              <li
                key={q.id}
                className={s.question}
                data-result={q.result ?? undefined}
                data-testid="test-question"
              >
                <div className={s.qHead}>
                  <span className={s.qNum}>Q{q.n}</span>
                  <span className={s.hint}>
                    {q.points} pt{q.points === 1 ? '' : 's'}
                    {q.concept ? ` · ${q.concept}` : ''}
                  </span>
                </div>
                <MarkdownView html={html[q.id] ?? ''} />
                <div className={s.qActions}>
                  <button type="button" className={s.chip} onClick={() => toggle(q.id)}>
                    <Icon icon={revealed.has(q.id) ? EyeOff : Eye} />{' '}
                    {revealed.has(q.id) ? 'Hide answer' : 'Reveal answer'}
                  </button>
                  <Segmented<TestResult | 'none'>
                    aria-label={`Result for question ${q.n}`}
                    size="sm"
                    value={q.result ?? 'none'}
                    options={[{ value: 'none', label: '—', disabled: true }, ...RESULTS]}
                    onChange={(v) =>
                      start(async () => {
                        await markQuestionAction(slug, test.id, q.id, v === 'none' ? null : v);
                        router.refresh();
                      })
                    }
                  />
                </div>
                {revealed.has(q.id) && (
                  <div className={s.answer} data-testid="model-answer">
                    <span className={s.answerLabel}>Model answer</span>
                    <MarkdownView html={answerHtml[q.id] ?? ''} />
                  </div>
                )}
              </li>
            ))}
          </ol>
          {test.status === 'ready' && (
            <div className={s.finish}>
              {error && <span className={s.error}>{error}</span>}
              <Button
                variant="primary"
                disabled={!allMarked || pending}
                onClick={() =>
                  start(async () => {
                    const res = await finishMarkingAction(slug, test.id);
                    if (res.error) setError(res.error);
                    else router.refresh();
                  })
                }
              >
                Finish marking
              </Button>
              {!allMarked && <span className={s.hint}>Mark every question to finish.</span>}
            </div>
          )}
          {test.status === 'marked' && (
            <section className={s.rereadSection}>
              <h2 className={s.h2}>To re-read</h2>
              {reread.length > 0 ? (
                <RereadList items={reread} base={base} />
              ) : rereadPending ? (
                <p className={s.muted}>Picking the note sections to revisit…</p>
              ) : (
                <p className={s.muted}>Nothing to re-read: every question passed.</p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
