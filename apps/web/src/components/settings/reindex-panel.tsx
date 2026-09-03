'use client';

import { Button } from '@ezragubbay/folio';
import { useState, useTransition } from 'react';
import { reindexAction } from '@/app/actions/chat';
import s from './settings.module.css';

export function ReindexPanel({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <section className={s.section}>
      <h2 className={s.h2}>AI index</h2>
      <p className={s.help}>
        Documents, notes, annotations, and sources are embedded when saved. Use this after enabling AI, or to
        catch anything that was missed.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => setResult(`Indexed ${(await reindexAction(slug)).indexed} items.`))
          }
        >
          {pending ? 'Indexing…' : 'Index missing items'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => setResult(`Re-indexed ${(await reindexAction(slug, true)).indexed} items.`))
          }
        >
          Re-index everything
        </Button>
        {result && <span className={s.help}>{result}</span>}
      </div>
    </section>
  );
}
