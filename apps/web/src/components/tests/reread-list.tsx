'use client';

import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toggleRereadAction } from '@/app/actions/tests';
import { useProject } from '@/components/project-context';
import type { RereadItem } from '@/db/schema';
import s from './tests.module.css';

/** Deep links to the note sections and slides the model picked after a test; tick them off as you re-read. */
export function RereadList({
  items,
  base,
  compact = false,
}: {
  items: (RereadItem & { testTitle?: string })[];
  base: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const { slug } = useProject();
  const [, start] = useTransition();
  const href = (it: RereadItem) =>
    it.targetKind === 'note'
      ? `${base}/notes/${it.targetId}${it.anchor ? `#${it.anchor}` : ''}`
      : `${base}/documents/${it.targetId}${it.anchor ? `?page=${it.anchor}` : ''}`;
  return (
    <ul className={s.reread} data-compact={compact || undefined} data-testid="reread-list">
      {items.map((it) => (
        <li key={it.id} className={s.rereadItem} data-done={it.done || undefined}>
          <input
            type="checkbox"
            checked={it.done}
            aria-label={`Mark "${it.title}" as re-read`}
            onChange={(e) =>
              start(async () => {
                await toggleRereadAction(slug, it.id, e.target.checked);
                router.refresh();
              })
            }
          />
          <span className={s.rereadText}>
            <NextLink href={href(it)}>{it.title}</NextLink>
            {it.reason && <span className={s.rereadReason}>{it.reason}</span>}
            {!compact && it.testTitle && <span className={s.rereadReason}>from {it.testTitle}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
