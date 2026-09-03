'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import s from './ui.module.css';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** A native <dialog> styled with Folio tokens. Closes on Escape and backdrop click. */
export function Dialog({ open, title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={s.dialog}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={s.dialogHead}>
        <h2 className={s.dialogTitle}>{title}</h2>
        <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} icon={<Icon icon={X} />} />
      </div>
      <div className={s.dialogBody}>{children}</div>
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={s.dialogActions}>{children}</div>;
}
