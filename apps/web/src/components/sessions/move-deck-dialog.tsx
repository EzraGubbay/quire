'use client';

import { Button } from '@ezragubbay/folio';
import type { SessionKind } from '@quire/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { moveDeckToSessionAction } from '@/app/actions/sessions';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import type { Session } from '@/db/schema';
import s from './sessions.module.css';

/** Sentinel for the "no lecture" radio; a real session id never collides with it. */
const UNASSIGN = '__unassign__';

// Kept local (not imported from lib/sessions, which pulls in the DB client) so this stays a clean client
// component — same approach as SessionsList.
const LABEL: Record<SessionKind, { one: string; many: string }> = {
  lecture: { one: 'Lecture', many: 'Lectures' },
  recitation: { one: 'Recitation', many: 'Recitations' },
};
const sessionTitle = (x: Session) => `${LABEL[x.kind].one} ${x.number}${x.title ? ` — ${x.title}` : ''}`;

/**
 * Dialog to move one deck to a different lecture/recitation (or unassign it). Reuses the same `Dialog`
 * shell as the edit-session flow. `sessions` is every session in the project so a deck can move across
 * kinds; the picker groups them Lectures then Recitations.
 */
export function MoveDeckDialog({
  slug,
  doc,
  sessions,
  currentSessionId,
  onClose,
  onMoved,
}: {
  slug: string;
  doc: { id: string; title: string };
  sessions: Session[];
  currentSessionId: string | null;
  onClose: () => void;
  onMoved?: () => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<string>(currentSessionId ?? UNASSIGN);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const lectures = sessions.filter((x) => x.kind === 'lecture');
  const recitations = sessions.filter((x) => x.kind === 'recitation');

  const move = () =>
    start(async () => {
      setError('');
      const target = choice === UNASSIGN ? null : choice;
      if (target === currentSessionId) {
        onClose(); // nothing changed
        return;
      }
      const res = await moveDeckToSessionAction(slug, doc.id, target);
      if (res.error) setError(res.error);
      else {
        router.refresh();
        onMoved?.();
        onClose();
      }
    });

  const option = (value: string, label: string, isCurrent: boolean) => (
    <label key={value} className={s.moveOption}>
      <input
        type="radio"
        name="move-target"
        value={value}
        checked={choice === value}
        onChange={() => setChoice(value)}
      />
      <span>
        {label}
        {isCurrent && <span className={s.moveCurrent}> (current)</span>}
      </span>
    </label>
  );

  return (
    <Dialog open title="Move deck" onClose={onClose}>
      <p className={s.moveIntro}>
        Move <strong>{doc.title}</strong> to:
      </p>
      <div className={s.moveList} data-testid="move-deck-list">
        {lectures.length > 0 && (
          <fieldset className={s.moveGroup}>
            <legend className={s.moveLegend}>{LABEL.lecture.many}</legend>
            {lectures.map((x) => option(x.id, sessionTitle(x), x.id === currentSessionId))}
          </fieldset>
        )}
        {recitations.length > 0 && (
          <fieldset className={s.moveGroup}>
            <legend className={s.moveLegend}>{LABEL.recitation.many}</legend>
            {recitations.map((x) => option(x.id, sessionTitle(x), x.id === currentSessionId))}
          </fieldset>
        )}
        <fieldset className={s.moveGroup}>{option(UNASSIGN, 'Unassign', currentSessionId === null)}</fieldset>
      </div>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" disabled={pending} onClick={move} data-testid="move-deck-go">
          {pending ? 'Moving…' : 'Move'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
