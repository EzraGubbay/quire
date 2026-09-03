'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { RunStatus } from '@quire/shared';
import { ArrowLeft, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  addObservationAction,
  deleteObservationAction,
  deleteRunAction,
  setRunStatusAction,
  updateRunNotesAction,
} from '@/app/actions/experiments';
import { MarkdownView } from '@/components/documents/markdown-view';
import type { Experiment, Observation, Run, RunArtifact, RunLog, RunMetric } from '@/db/schema';
import s from './experiments.module.css';
import { MetricChart } from './metric-chart';

export function RunView({
  slug,
  experiment,
  run,
  metrics,
  logs,
  artifacts,
  observations,
  observationHtml,
}: {
  slug: string;
  experiment: Experiment;
  run: Run;
  metrics: RunMetric[];
  logs: RunLog[];
  artifacts: RunArtifact[];
  observations: Observation[];
  observationHtml: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [obs, setObs] = useState('');
  const [notes, setNotes] = useState(run.notes);
  const byKey = new Map<string, RunMetric[]>();
  for (const m of metrics) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);
  const params = run.params as Record<string, unknown>;
  const refresh = () => router.refresh();
  return (
    <div className={s.wrap}>
      <NextLink href={`/p/${slug}/experiments/${experiment.id}`} className={s.crumb}>
        <Icon icon={ArrowLeft} /> {experiment.name}
      </NextLink>
      <div className={s.head}>
        <div>
          <h1 className={s.title}>{run.name}</h1>
          <p className={s.mono}>
            {run.startedAt
              ? `started ${run.startedAt.toLocaleString('en-GB')}`
              : `created ${run.createdAt.toLocaleString('en-GB')}`}
            {run.finishedAt ? ` · finished ${run.finishedAt.toLocaleString('en-GB')}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['queued', 'running', 'done', 'failed'] as RunStatus[]).map((st) => (
            <button
              key={st}
              type="button"
              className={s.chip}
              data-active={run.status === st}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await setRunStatusAction(slug, run.id, st);
                  refresh();
                })
              }
            >
              {st}
            </button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon icon={Trash2} />}
            aria-label="Delete run"
            onClick={() => {
              if (window.confirm(`Delete run "${run.name}"?`)) start(() => deleteRunAction(slug, run.id));
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className={s.grid}>
        <section className={s.card}>
          <h2 className={s.cardTitle}>Params</h2>
          {Object.keys(params).length === 0 ? (
            <p className={s.muted}>None recorded.</p>
          ) : (
            <dl className={s.kv}>
              {Object.entries(params).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        <section className={s.card}>
          <h2 className={s.cardTitle}>Summary</h2>
          {Object.keys(run.summary as object).length === 0 ? (
            <p className={s.muted}>No metrics yet.</p>
          ) : (
            <dl className={s.kv}>
              {Object.entries(run.summary as Record<string, number>).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        {[...byKey.entries()].map(([key, pts]) => (
          <section key={key} className={s.card}>
            <MetricChart name={key} points={pts} />
          </section>
        ))}
      </div>
      <section className={s.card}>
        <h2 className={s.cardTitle}>Observations</h2>
        {observations.map((o) => (
          <div key={o.id} className={s.obs}>
            <span className={s.obsMeta}>
              {o.createdAt.toLocaleString('en-GB', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
              <button
                type="button"
                className={s.iconBtn}
                aria-label="Delete observation"
                style={{ marginLeft: 8 }}
                onClick={() =>
                  start(async () => {
                    await deleteObservationAction(slug, run.id, o.id);
                    refresh();
                  })
                }
              >
                <Icon icon={Trash2} />
              </button>
            </span>
            <MarkdownView html={observationHtml[o.id] ?? ''} />
          </div>
        ))}
        <textarea
          className={s.textarea}
          aria-label="New observation"
          placeholder="What did you see? Markdown, math, and [[wiki links]] work. Cmd/Ctrl+Enter to add."
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && obs.trim()) {
              e.preventDefault();
              start(async () => {
                await addObservationAction(slug, run.id, obs);
                setObs('');
                refresh();
              });
            }
          }}
        />
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || !obs.trim()}
            onClick={() =>
              start(async () => {
                await addObservationAction(slug, run.id, obs);
                setObs('');
                refresh();
              })
            }
          >
            Add observation
          </Button>
        </div>
      </section>
      <div className={s.grid}>
        <section className={s.card}>
          <h2 className={s.cardTitle}>Notes</h2>
          <textarea
            className={s.textarea}
            aria-label="Run notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== run.notes && start(() => updateRunNotesAction(slug, run.id, notes))}
          />
        </section>
        <section className={s.card}>
          <h2 className={s.cardTitle}>Artifacts</h2>
          {artifacts.length === 0 ? (
            <p className={s.muted}>None uploaded. Use run.artifact(path) from Python.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {artifacts.map((a) => (
                <li key={a.id} className={s.mono}>
                  <a href={`/api/projects/${slug}/artifacts/${a.id}`}>{a.name}</a> ·{' '}
                  {(a.size / 1024).toFixed(1)} KB
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className={s.card}>
        <h2 className={s.cardTitle}>Log · {logs.length}</h2>
        {logs.length === 0 ? (
          <p className={s.muted}>Nothing logged. Use run.print(...) from Python.</p>
        ) : (
          <div className={s.log}>
            {logs.map((l) => (
              <div key={l.id} className={s.logLine} data-level={l.level}>
                <span className={s.logTs}>{l.ts.toLocaleTimeString('en-GB')}</span>
                {l.message}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
