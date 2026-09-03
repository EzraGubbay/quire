'use client';

import { Button, Card, CardRow, Icon } from '@ezragubbay/folio';
import { Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useActionState, useState } from 'react';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import type { Project } from '@/db/schema';
import { type ActionState, createProjectAction } from './actions/projects';
import s from './home.module.css';

export function HomeView({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(createProjectAction, {});
  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div>
          <h1 className={s.title}>Projects</h1>
          <p className={s.sub}>One workspace per research project.</p>
        </div>
        <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
          New project
        </Button>
      </header>
      <Card title="Active" action={<span className={s.count}>{projects.length}</span>}>
        {projects.length === 0 ? (
          <p className={s.empty}>No projects yet. Create one to start collecting papers and notes.</p>
        ) : (
          projects.map((p) => (
            <CardRow
              key={p.id}
              title={<NextLink href={`/p/${p.slug}/overview`}>{p.name}</NextLink>}
              meta={p.description || 'No description'}
            />
          ))
        )}
      </Card>
      <Dialog open={open} title="New project" onClose={() => setOpen(false)}>
        <form action={action} className={s.form}>
          <Field label="Name" error={state.error}>
            <Input name="name" required maxLength={120} autoFocus placeholder="Sparse attention survey" />
          </Field>
          <Field label="Description" hint="Optional. One or two lines about what this project is for.">
            <Textarea name="description" maxLength={2000} />
          </Field>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Creating…' : 'Create project'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}
