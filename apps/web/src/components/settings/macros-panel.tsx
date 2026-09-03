'use client';

import { Button, Icon, MathInline } from '@ezragubbay/folio';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useTransition } from 'react';
import { type ActionState, addMacrosAction, deleteMacroAction } from '@/app/actions/macros';
import { Field, Textarea } from '@/components/ui/field';
import type { Macro } from '@/db/schema';
import s from './settings.module.css';

export function MacrosPanel({
  scope,
  slug,
  macros,
  inherited,
}: {
  scope: 'global' | 'project';
  slug?: string;
  macros: Macro[];
  inherited?: Macro[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(addMacrosAction, {});
  const [, start] = useTransition();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <section className={s.section}>
      <h2 className={s.h2}>{scope === 'global' ? 'Math macros' : 'Project macros'}</h2>
      <p className={s.help}>
        {scope === 'global'
          ? 'Available in every project: notes, documents, annotations, and chat. Written as LaTeX \\newcommand lines.'
          : 'Override or add macros for this project only. Same syntax as the global set.'}
      </p>
      {macros.length > 0 && (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Macro</th>
              <th>Definition</th>
              <th>Renders</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {macros.map((m) => (
              <tr key={m.id}>
                <td>
                  <code>
                    \{m.name}
                    {m.arity > 0 ? `[${m.arity}]` : ''}
                  </code>
                </td>
                <td>
                  <code>{m.definition}</code>
                </td>
                <td>
                  <MathInline
                    tex={
                      m.arity > 0
                        ? `\\${m.name}{${Array.from({ length: m.arity }, (_, i) => `x_${i + 1}`).join('}{')}}`
                        : `\\${m.name}`
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={s.iconBtn}
                    aria-label={`Delete macro ${m.name}`}
                    onClick={() =>
                      start(async () => {
                        await deleteMacroAction(m.id, slug);
                        router.refresh();
                      })
                    }
                  >
                    <Icon icon={Trash2} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {inherited && inherited.length > 0 && (
        <p className={s.help}>Inherited from global: {inherited.map((m) => `\\${m.name}`).join(', ')}</p>
      )}
      <form action={action} className={s.form}>
        {slug && <input type="hidden" name="slug" value={slug} />}
        <Field
          label="Add macros, one per line"
          hint="\\newcommand{\\E}{\\mathbb{E}}   or   \\KL[2]: D_{\\mathrm{KL}}(#1 \\,\\|\\, #2)"
          error={state.error}
        >
          <Textarea
            name="text"
            rows={4}
            placeholder={'\\newcommand{\\E}{\\mathbb{E}}\n\\norm[1]: \\left\\lVert #1 \\right\\rVert'}
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Add macros'}
          </Button>
          {state.ok && state.added ? <span className={s.help}> {state.added} saved.</span> : null}
        </div>
      </form>
    </section>
  );
}
