'use client';

import { Button, Card, CardRow, Icon } from '@ezragubbay/folio';
import { COURSE_TYPES, type ProjectKind } from '@quire/shared';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState, useTransition } from 'react';
import {
  type ActionState,
  createCourseAction,
  createProjectAction,
  setProjectStatusAction,
} from '@/app/actions/projects';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import type { Project } from '@/db/schema';
import { baseFor } from '@/lib/side';
import s from './workspace.module.css';

export interface DueItem {
  id: string;
  title: string;
  courseName: string;
  href: string;
  dueAt: string;
}

export interface WorkspaceHomeProps {
  kind: ProjectKind;
  active: Project[];
  archived: Project[];
  /** Courses only: assignments due in the next seven days across active courses. */
  dueSoon?: DueItem[];
}

const COPY = {
  research: {
    title: 'Projects',
    sub: 'One workspace per research project.',
    newLabel: 'New project',
    noun: 'project',
    emptyActive: 'No projects yet. Create one to start collecting papers and notes.',
  },
  course: {
    title: 'Courses',
    sub: 'One workspace per course: lectures, notes, homework, tests.',
    newLabel: 'New course',
    noun: 'course',
    emptyActive: 'No courses yet. Create one and drop the first lecture deck on it.',
  },
} as const;

const TYPE_LABEL: Record<(typeof COURSE_TYPES)[number], string> = {
  practical: 'Practical',
  theoretical: 'Theoretical',
  mixed: 'Mixed',
};

function rowMeta(p: Project): string {
  if (p.kind !== 'course') return p.description || 'No description';
  const meta = (p.meta ?? {}) as { code?: string; semester?: string };
  return [meta.code, meta.semester, p.description].filter(Boolean).join(' · ') || 'No details yet';
}

export function WorkspaceHome({ kind, active, archived, dueSoon = [] }: WorkspaceHomeProps) {
  const copy = COPY[kind];
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const [, start] = useTransition();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const storageKey = `quire.archived.open.${kind}`;
  useEffect(() => {
    try {
      setArchivedOpen(window.localStorage.getItem(storageKey) === '1');
    } catch {}
  }, [storageKey]);
  const toggleArchived = () => {
    setArchivedOpen((o) => {
      try {
        window.localStorage.setItem(storageKey, o ? '0' : '1');
      } catch {}
      return !o;
    });
  };

  const setStatus = (p: Project, status: 'active' | 'archived') =>
    start(async () => {
      await setProjectStatusAction(p.id, status);
      router.refresh();
    });
  const archive = (p: Project) => {
    setStatus(p, 'archived');
    toast({
      message: `Archived ${p.name}`,
      action: { label: 'Undo', onClick: () => setStatus(p, 'active') },
    });
  };
  const restore = (p: Project) => {
    setStatus(p, 'active');
    toast({ message: `Restored ${p.name}` });
  };

  const row = (p: Project, archivedRow: boolean) => (
    <CardRow
      key={p.id}
      title={<NextLink href={`${baseFor(p.kind, p.slug)}/overview`}>{p.name}</NextLink>}
      meta={rowMeta(p)}
      trailing={
        <button
          type="button"
          className={s.iconBtn}
          aria-label={archivedRow ? `Unarchive ${p.name}` : `Archive ${p.name}`}
          title={archivedRow ? 'Unarchive' : 'Archive'}
          onClick={() => (archivedRow ? restore(p) : archive(p))}
        >
          <Icon icon={archivedRow ? ArchiveRestore : Archive} />
        </button>
      }
    />
  );

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div>
          <h1 className={s.title}>{copy.title}</h1>
          <p className={s.sub}>{copy.sub}</p>
        </div>
        <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setOpen(true)}>
          {copy.newLabel}
        </Button>
      </header>
      {kind === 'course' && dueSoon.length > 0 && (
        <Card title="Due this week" action={<span className={s.count}>{dueSoon.length}</span>}>
          {dueSoon.map((d) => (
            <CardRow
              key={d.id}
              title={<NextLink href={d.href}>{d.title}</NextLink>}
              meta={`${d.courseName} · ${d.dueAt}`}
            />
          ))}
        </Card>
      )}
      <Card title="Active" action={<span className={s.count}>{active.length}</span>}>
        {active.length === 0 ? (
          <p className={s.empty}>{copy.emptyActive}</p>
        ) : (
          active.map((p) => row(p, false))
        )}
      </Card>
      <section className={s.archived} data-testid="archived-section">
        <button
          type="button"
          className={s.archivedToggle}
          aria-expanded={archivedOpen}
          onClick={toggleArchived}
        >
          <Icon icon={archivedOpen ? ChevronDown : ChevronRight} />
          <span>Archived</span>
          <span className={s.count}>{archived.length}</span>
        </button>
        {archivedOpen && (
          <Card title="Archived">
            {archived.length === 0 ? (
              <p className={s.empty}>
                Nothing archived. Archiving only hides a {copy.noun} from the active list.
              </p>
            ) : (
              archived.map((p) => row(p, true))
            )}
          </Card>
        )}
      </section>
      {kind === 'course' ? (
        <NewCourseDialog open={open} onClose={() => setOpen(false)} />
      ) : (
        <NewProjectDialog open={open} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createProjectAction, {});
  return (
    <Dialog open={open} title="New project" onClose={onClose}>
      <form action={action} className={s.form}>
        <Field label="Name" error={state.error}>
          <Input name="name" required maxLength={120} autoFocus placeholder="Sparse attention survey" />
        </Field>
        <Field label="Description" hint="Optional. One or two lines about what this project is for.">
          <Textarea name="description" maxLength={2000} />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create project'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function NewCourseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createCourseAction, {});
  const [type, setType] = useState<(typeof COURSE_TYPES)[number]>('mixed');
  return (
    <Dialog open={open} title="New course" onClose={onClose}>
      <form action={action} className={s.form}>
        <Field label="Name" error={state.error}>
          <Input name="name" required maxLength={120} autoFocus placeholder="Parallel Systems Programming" />
        </Field>
        <fieldset className={s.fieldset}>
          <legend className={s.legend}>Type</legend>
          <div className={s.radios}>
            {COURSE_TYPES.map((t) => (
              <label key={t} className={s.radio} data-active={type === t}>
                <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} />
                <span>{TYPE_LABEL[t]}</span>
              </label>
            ))}
          </div>
          <p className={s.hint}>
            Sets defaults only (synthesis style, templates). Everything is available in every course.
          </p>
        </fieldset>
        <div className={s.row}>
          <Field label="Course code" hint="Optional">
            <Input name="code" maxLength={40} placeholder="89-xxx" />
          </Field>
          <Field label="Semester" hint="Optional">
            <Input name="semester" maxLength={40} placeholder="2027 A" />
          </Field>
        </div>
        <Field label="Description" hint="Optional.">
          <Textarea name="description" maxLength={2000} />
        </Field>
        <Field label="Links" hint="One per line: Label | https://… (Moodle, recordings, course site).">
          <Textarea
            name="links"
            placeholder={'Moodle | https://lemida.biu.ac.il/...\nRecordings | https://...'}
          />
        </Field>
        <DialogActions>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create course'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
