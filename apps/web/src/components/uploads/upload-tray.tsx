'use client';

import { useEffect } from 'react';
import { useUploads } from './upload-provider';
import s from './upload-tray.module.css';

const AUTO_DISMISS_MS = 4000;

/** App-wide corner tray for background uploads. Mounted once in Providers. */
export function UploadTray() {
  const { uploads, dismiss } = useUploads();
  const doneKey = uploads
    .filter((u) => u.status === 'done')
    .map((u) => u.id)
    .join(',');
  useEffect(() => {
    if (!doneKey) return;
    const timers = doneKey.split(',').map((id) => window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [doneKey, dismiss]);
  if (uploads.length === 0) return null;
  return (
    <section className={s.tray} aria-label="Uploads" aria-live="polite" data-testid="upload-tray">
      {uploads.map((u) => (
        <div key={u.id} className={s.item} data-status={u.status} data-testid="upload-item">
          <div className={s.row}>
            <span className={s.name} title={u.name}>
              {u.name}
            </span>
            <span className={s.state}>
              {u.status === 'uploading'
                ? `${Math.round(u.progress * 100)}%`
                : u.status === 'done'
                  ? 'Done'
                  : 'Failed'}
            </span>
            <button
              type="button"
              className={s.close}
              aria-label={u.status === 'uploading' ? `Cancel upload of ${u.name}` : `Dismiss ${u.name}`}
              onClick={() => dismiss(u.id)}
            >
              ×
            </button>
          </div>
          {u.status === 'error' ? (
            <p className={s.error} role="alert">
              {u.error}
            </p>
          ) : (
            <progress className={s.bar} value={u.progress} max={1} aria-label={`Uploading ${u.name}`} />
          )}
        </div>
      ))}
    </section>
  );
}
