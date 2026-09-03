'use client';

import { Card, CardRow } from '@ezragubbay/folio';
import NextLink from 'next/link';
import type { Project } from '@/db/schema';
import s from './home.module.css';

export function HomeView({ projects }: { projects: Project[] }) {
  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>Projects</h1>
        <p className={s.sub}>One workspace per research project.</p>
      </header>
      <Card title="Active" action={<span className={s.count}>{projects.length}</span>}>
        {projects.length === 0 ? (
          <p className={s.empty}>No projects yet. Creating projects arrives in Phase 1.</p>
        ) : (
          projects.map((p) => (
            <CardRow
              key={p.id}
              title={<NextLink href={`/p/${p.slug}/overview`}>{p.name}</NextLink>}
              meta={p.description}
            />
          ))
        )}
      </Card>
    </div>
  );
}
