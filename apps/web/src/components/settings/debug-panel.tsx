'use client';

import { Button } from '@ezragubbay/folio';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { clearLogsAction, setDebugAction } from '@/app/actions/debug';
import type { ClientLog } from '@/db/schema';
import type { SessionSummary } from '@/lib/debug';
import { isDebug, log, setDebug } from '@/lib/debug-client';
import s from './settings.module.css';

export function DebugPanel({
  serverOn,
  sessions,
  logs,
  full,
}: {
  serverOn: boolean;
  sessions: SessionSummary[];
  logs: ClientLog[];
  full: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(serverOn);
  const [localOn, setLocalOn] = useState(false);
  const [session, setSession] = useState<string>('');
  const [level, setLevel] = useState<string>('');
  const [pending, start] = useTransition();
  useEffect(() => setLocalOn(isDebug()), []);
  const shown = logs.filter((l) => (!session || l.session === session) && (!level || l.level === level));
  return (
    <section className={s.section}>
      <h2 className={s.h2}>Debug</h2>
      <p className={s.help}>
        When on, every device records JavaScript errors, console warnings, viewer render events with canvas
        sizes and memory, and a state marker that reports a crash on the next open. Entries are sent to the Pi
        as they happen and kept 14 days. Off by default; nothing is collected when off.
      </p>
      <label className={s.radio} data-active={on}>
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            setDebug(next);
            setLocalOn(next);
            start(async () => {
              await setDebugAction(next);
              if (next) log('info', 'debug', 'debug mode turned on from settings');
              router.refresh();
            });
          }}
        />
        <span>
          <strong>Debug mode {on ? 'on' : 'off'}</strong>
          <span className={s.help}>
            Applies to all devices on next load
            {localOn !== on ? ` (this device: ${localOn ? 'on' : 'off'} until reload)` : ''}.
          </span>
        </span>
      </label>
      {full && (
        <>
          <h3 className={s.h3}>Sessions · {sessions.length}</h3>
          {sessions.length === 0 ? (
            <p className={s.help}>
              No entries yet. Turn debug on, open the page that fails on the device, then come back here.
            </p>
          ) : (
            <table className={s.table} data-testid="debug-sessions">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Device</th>
                  <th>Last</th>
                  <th>Entries</th>
                  <th>Errors</th>
                  <th>Crash</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((x) => (
                  <tr
                    key={x.session}
                    style={x.session === session ? { background: 'var(--eg-accent-soft)' } : undefined}
                  >
                    <td>
                      <button
                        type="button"
                        className={s.linkBtn}
                        onClick={() => setSession((v) => (v === x.session ? '' : x.session))}
                      >
                        {x.session.slice(0, 8)}
                      </button>
                    </td>
                    <td className={s.help}>
                      {x.platform ?? '?'} ·{' '}
                      {(x.userAgent ?? '').match(/iPhone|iPad|Macintosh|Android|Windows/)?.[0] ?? 'unknown'}
                    </td>
                    <td className={s.num}>
                      {x.last.toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className={s.num}>{x.entries}</td>
                    <td className={s.num}>{x.errors}</td>
                    <td>{x.crash ? <strong style={{ color: 'var(--eg-accent-text)' }}>yes</strong> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              className={s.select}
              aria-label="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="">All levels</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
            {session && (
              <Button variant="secondary" size="sm" onClick={() => setSession('')}>
                All sessions
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await clearLogsAction();
                  router.refresh();
                })
              }
            >
              Clear log
            </Button>
            <span className={s.help}>
              Also readable with <code>GET /api/client-log?session=…</code> and the API key.
            </span>
          </div>
          <div className={s.logBox} data-testid="debug-log">
            {shown.length === 0 ? (
              <span className={s.help}>Nothing matches.</span>
            ) : (
              shown.map((l) => (
                <div key={l.id} className={s.logLine} data-level={l.level}>
                  <span className={s.logTs}>{l.clientTs.toLocaleTimeString('en-GB')}</span> <b>{l.level}</b>{' '}
                  <i>{l.source}</i> {l.message}
                  {l.data != null && (
                    <span className={s.logData}> {JSON.stringify(l.data).slice(0, 400)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}
