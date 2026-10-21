'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import s from './toast.module.css';

export interface ToastInput {
  message: string;
  /** One optional action, e.g. Undo. The toast closes after it runs. */
  action?: { label: string; onClick: () => void | Promise<void> };
  /** Milliseconds before the toast dismisses itself. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastCtx {
  toast: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });

export function useToast(): ToastCtx {
  return useContext(ToastContext);
}

/** Bottom-centre toasts, one at a time plus a short queue. Mounted once in Providers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.duration ?? 6000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={s.region} aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <output key={t.id} className={s.toast} data-testid="toast">
            <span className={s.message}>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className={s.action}
                onClick={async () => {
                  dismiss(t.id);
                  await t.action?.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className={s.close} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </output>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
