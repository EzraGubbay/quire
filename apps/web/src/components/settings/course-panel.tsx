'use client';

import { Button } from '@ezragubbay/folio';
import { COURSE_TYPES, type ProjectMeta } from '@quire/shared';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { type ActionState, updateCourseMetaAction } from '@/app/actions/projects';
import { Field, Input, Textarea } from '@/components/ui/field';
import s from './settings.module.css';

const TYPE_LABEL: Record<(typeof COURSE_TYPES)[number], string> = {
  practical: 'Practical',
  theoretical: 'Theoretical',
  mixed: 'Mixed',
};

export function CoursePanel({
  project,
  meta,
}: {
  project: { id: string; name: string; description: string };
  meta: ProjectMeta;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateCourseMetaAction, {});
  const [type, setType] = useState(meta.type);
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <section className={s.section}>
      <h2 className={s.h2}>Course</h2>
      <p className={s.help}>Type sets defaults only (synthesis style, templates); nothing is hidden by it.</p>
      <form action={action} className={s.form}>
        <input type="hidden" name="id" value={project.id} />
        <Field label="Name" error={state.error}>
          <Input name="name" defaultValue={project.name} maxLength={120} required />
        </Field>
        <div className={s.radios}>
          {COURSE_TYPES.map((t) => (
            <label key={t} className={s.radio} data-active={type === t}>
              <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} />
              <span>{TYPE_LABEL[t]}</span>
            </label>
          ))}
        </div>
        <div className={s.row}>
          <Field label="Course code">
            <Input name="code" defaultValue={meta.code} maxLength={40} placeholder="89-xxx" />
          </Field>
          <Field label="Semester">
            <Input name="semester" defaultValue={meta.semester} maxLength={40} placeholder="2027 A" />
          </Field>
        </div>
        <Field label="Description">
          <Textarea name="description" defaultValue={project.description} maxLength={2000} />
        </Field>
        <Field label="Links" hint="One per line: Label | https://…">
          <Textarea name="links" defaultValue={meta.links.map((l) => `${l.label} | ${l.url}`).join('\n')} />
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save course'}
          </Button>
          {state.ok && <span className={s.help}> Saved.</span>}
        </div>
      </form>
    </section>
  );
}
