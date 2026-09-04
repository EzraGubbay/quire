'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useState, useTransition } from 'react';
import { type ActionState, createRunAction, deleteExperimentAction } from '@/app/actions/experiments';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { Experiment, Run } from '@/db/schema';
import s from './experiments.module.css';
import { fmt } from './metric-chart';

export function ExperimentView({
  slug,
  experiment,
  runs,
  readOnly = false,
}: {
  slug: string;
  experiment: Experiment;
  runs: Run[];
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(createRunAction, {});
  const [, start] = useTransition();
  const metricKeys = [
    ...new Set(runs.flatMap((r) => Object.keys((r.summary as Record<string, number>) ?? {}))),
  ].slice(0, 6);
  return (
    <div className={s.wrap}>
      <NextLink href={`/p/${slug}/experiments`} className={s.crumb}>
        <Icon icon={ArrowLeft} /> Experiments
      </NextLink>
      <div className={s.head}>
        <div>
          <h1 className={s.title}>{experiment.name}</h1>
          {experiment.description && <p className={s.desc}>{experiment.description}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!readOnly && (
            <>
              <Button variant="primary" size="sm" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
                New run
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon icon={Trash2} />}
                onClick={() => {
                  if (window.confirm(`Delete "${experiment.name}" and all its runs?`))
                    start(() => deleteExperimentAction(slug, experiment.id));
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {runs.length === 0 ? (
        <p className={s.muted}>No runs yet.</p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              {metricKeys.map((k) => (
                <th key={k}>{k}</th>
              ))}
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <NextLink href={`/p/${slug}/experiments/${experiment.id}/runs/${r.id}`}>{r.name}</NextLink>
                  <div className={s.mono}>{paramsLine(r.params as Record<string, unknown>)}</div>
                </td>
                <td>
                  <span className={s.status} data-status={r.status}>
                    {r.status}
                  </span>
                </td>
                {metricKeys.map((k) => (
                  <td key={k} className={s.mono}>
                    {fmt((r.summary as Record<string, number>)[k])}
                  </td>
                ))}
                <td className={s.mono}>
                  {(r.startedAt ?? r.createdAt).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog open={open} title="New run" onClose={() => setOpen(false)}>
        <form action={action} className={s.form}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="experimentId" value={experiment.id} />
          <Field label="Name" hint="Optional; defaults to run-N." error={state.error}>
            <Input name="name" maxLength={200} autoFocus />
          </Field>
          <Field label="Status">
            <select name="status" className={s.chip} defaultValue="queued">
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="done">done</option>
              <option value="failed">failed</option>
            </select>
          </Field>
          <Field label="Params" hint="JSON, or key=value lines.">
            <Textarea name="params" rows={4} placeholder={'lambda=0.1\nseq=32768'} />
          </Field>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Create run
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}

export function paramsLine(p: Record<string, unknown>): string {
  return Object.entries(p)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
}
