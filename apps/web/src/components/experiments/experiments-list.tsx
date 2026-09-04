'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useState } from 'react';
import { type ActionState, createExperimentAction } from '@/app/actions/experiments';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { ExperimentWithCounts } from '@/lib/experiments';
import s from './experiments.module.css';

export function ExperimentsList({
  slug,
  experiments,
  apiHint,
  readOnly = false,
}: {
  slug: string;
  experiments: ExperimentWithCounts[];
  apiHint: string;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(createExperimentAction, {});
  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <h1 className={s.title}>Experiments</h1>
        {!readOnly && (
          <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
            New experiment
          </Button>
        )}
      </div>
      {experiments.length === 0 ? (
        <>
          <p className={s.muted}>
            No experiments yet. Create one here, or start a run from Python and it appears on its own:
          </p>
          <pre className={s.snippet}>{apiHint}</pre>
        </>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Experiment</th>
              <th>Runs</th>
              <th>Running</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((e) => (
              <tr key={e.id}>
                <td>
                  <NextLink href={`/p/${slug}/experiments/${e.id}`}>{e.name}</NextLink>
                  {e.description && <div className={s.mono}>{e.description}</div>}
                </td>
                <td className={s.mono}>{e.runCount}</td>
                <td className={s.mono}>
                  {e.running > 0 ? (
                    <span className={s.status} data-status="running">
                      {e.running} running
                    </span>
                  ) : (
                    '–'
                  )}
                </td>
                <td className={s.mono}>
                  {e.lastRunAt
                    ? e.lastRunAt.toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog open={open} title="New experiment" onClose={() => setOpen(false)}>
        <form action={action} className={s.form}>
          <input type="hidden" name="slug" value={slug} />
          <Field label="Name" error={state.error} hint="The Python client matches on this name.">
            <Input name="name" required maxLength={200} autoFocus placeholder="routed-32k-lambda-sweep" />
          </Field>
          <Field label="Description">
            <Textarea name="description" rows={3} />
          </Field>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Create experiment
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}
