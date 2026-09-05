'use client';

import { type ReactNode, useEffect, useId } from 'react';
import s from './bottom-sheet.module.css';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Extra controls in the header, right of the title. */
  actions?: ReactNode;
  /** 'half' caps the sheet at 55dvh; 'full' at 88dvh. Content scrolls inside. */
  snap?: 'half' | 'full';
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Phone-first sheet that slides up from the bottom edge (thumb-reachable). Closes on scrim tap, the handle,
 * or Escape. Stays mounted while closed so open/close animates; the window itself never scrolls in Quire,
 * so no body scroll lock is needed.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  actions,
  snap = 'half',
  children,
  ...rest
}: BottomSheetProps) {
  const labelId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div className={s.root} data-open={open ? 'true' : 'false'} data-testid={rest['data-testid']}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the window level. */}
      <div className={s.scrim} onClick={onClose} aria-hidden="true" />
      <section
        className={s.sheet}
        data-snap={snap}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        aria-hidden={!open}
      >
        <button type="button" className={s.handle} aria-label="Close" onClick={onClose}>
          <span />
        </button>
        <header className={s.head}>
          <h2 id={labelId} className={s.title}>
            {title}
          </h2>
          <div className={s.actions}>{actions}</div>
        </header>
        <div className={s.body}>{children}</div>
      </section>
    </div>
  );
}
