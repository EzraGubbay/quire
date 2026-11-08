'use client';

import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { type LemidaIndicator, lemidaIndicator } from '@/lib/lemida/indicator';
import s from './status-dot.module.css';

/** The slice of `GET /api/lemida/state` the dot needs. */
interface StatePayload {
  sessionStatus: 'unknown' | 'valid' | 'expired';
  checkedAt: string | null;
}

const LABEL: Record<LemidaIndicator, string> = {
  green: 'Signed in to Lemida',
  orange: 'Lemida sign-in needs checking',
  red: 'Signed out of Lemida',
};

/** Same relative-time phrasing as the Lemida panel. */
const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return 'never';
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/**
 * Always-visible sign-in dot for the courses chrome. Polls the session state and colours itself
 * green / orange / red via {@link lemidaIndicator}; a timer at the next local midnight re-renders it so a
 * green dot lapses to orange on its own. Clicking opens the Lemida sync panel.
 */
export function LemidaStatusDot() {
  const [state, setState] = useState<StatePayload | null>(null);
  // Bumped at local midnight purely to force a recompute of the derived colour.
  const [, setMidnightTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/lemida/state', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<StatePayload>) : null))
        .then((d) => {
          if (alive && d) setState(d);
        })
        .catch(() => {});
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const next = new Date();
    next.setHours(24, 0, 0, 0); // next local midnight
    const id = window.setTimeout(
      () => setMidnightTick((t) => t + 1),
      Math.max(1000, next.getTime() - Date.now() + 1000),
    );
    return () => window.clearTimeout(id);
  });

  if (!state) return null;
  const color = lemidaIndicator(state, new Date());
  const title = `${LABEL[color]} · checked ${ago(state.checkedAt)}`;
  return (
    <NextLink
      href="/courses/lemida"
      className={s.dot}
      data-indicator={color}
      aria-label={title}
      title={title}
    >
      <span className={s.pip} />
    </NextLink>
  );
}
