'use client';

import { Icon } from '@ezragubbay/folio';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { noteVersionAction } from '@/app/actions/notes';
import { onNoteChange } from '@/lib/note-signal';
import s from './notes.module.css';

const POLL_MS = 4000;

/**
 * Keeps a note's read view current while it is edited elsewhere: a manual Refresh button, an instant refresh on a
 * same-browser save (BroadcastChannel), a refresh when the tab regains focus, and a light poll of the note's
 * updated_at while the tab is visible (covers another device, e.g. the iPad beside the laptop).
 */
export function LiveNote({ slug, noteId, updatedAt }: { slug: string; noteId: string; updatedAt: string }) {
  const router = useRouter();
  const [spinning, setSpinning] = useState(false);
  const known = useRef(updatedAt);
  known.current = updatedAt;
  const refresh = useCallback(() => {
    setSpinning(true);
    router.refresh();
    window.setTimeout(() => setSpinning(false), 600);
  }, [router]);

  // Same browser: a save anywhere announces the note id.
  useEffect(() => onNoteChange((c) => c.id === noteId && refresh()), [noteId, refresh]);

  // Other devices: compare updated_at every few seconds while the tab is visible; also on focus/visibility.
  useEffect(() => {
    let timer: number | null = null;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const at = await noteVersionAction(slug, noteId);
        if (at && at !== known.current) refresh();
      } catch {
      } finally {
        busy = false;
      }
    };
    const start = () => {
      if (timer === null) timer = window.setInterval(check, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void check();
        start();
      } else stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    if (document.visibilityState === 'visible') start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
    };
  }, [slug, noteId, refresh]);

  return (
    <button
      type="button"
      className={s.chip}
      onClick={refresh}
      title="Refresh (the view also follows saves made elsewhere)"
      aria-label="Refresh note"
      data-testid="note-refresh"
    >
      <Icon icon={RefreshCw} />
      <span className={s.refreshLabel} data-spinning={spinning || undefined}>
        Refresh
      </span>
    </button>
  );
}
