import type { LemidaCommandKind, LemidaCommandStatus } from '@quire/shared';
import { describe, expect, it } from 'vitest';
import { type CommandView, describeCommand } from './command-view';

const now = new Date('2026-11-24T12:00:00Z');
const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60000).toISOString();
const cmd = (o: Partial<CommandView> & { status: LemidaCommandStatus }): CommandView => ({
  id: 'c',
  kind: 'sync',
  payload: {},
  result: {},
  createdAt: at(5),
  updatedAt: at(5),
  ...o,
});

describe('describeCommand', () => {
  it('labels each kind', () => {
    const labels = (['open_login', 'probe', 'sync'] as LemidaCommandKind[]).map(
      (kind) => describeCommand(cmd({ kind, status: 'pending' }), now).label,
    );
    expect(labels).toEqual(['Sign in', 'Session check', 'Sync']);
  });

  it('pending: waiting, uses createdAt and the injected now', () => {
    const d = describeCommand(cmd({ status: 'pending', createdAt: at(2) }), now);
    expect(d).toEqual({
      label: 'Sync',
      text: 'waiting for the desktop app · queued 2m ago',
      tone: 'neutral',
    });
  });

  it('running: uses updatedAt as the start time', () => {
    const d = describeCommand(cmd({ status: 'running', updatedAt: at(1), createdAt: at(30) }), now);
    expect(d.text).toBe('running on your Mac · started 1m ago');
    expect(d.tone).toBe('neutral');
  });

  it('error includes result.message, tone error', () => {
    const d = describeCommand(cmd({ status: 'error', result: { message: 'boom' } }), now);
    expect(d.text).toBe('failed 5m ago: boom');
    expect(d.tone).toBe('error');
    expect(describeCommand(cmd({ status: 'error' }), now).text).toBe('failed 5m ago: no details');
  });

  it('cuts long messages to 300 chars', () => {
    const d = describeCommand(cmd({ status: 'error', result: { message: 'x'.repeat(1000) } }), now);
    expect(d.text.length).toBe('failed 5m ago: '.length + 300);
    expect(d.text.endsWith('…')).toBe(true);
  });

  it('marks automatic and full-rescan syncs', () => {
    expect(describeCommand(cmd({ status: 'pending', payload: { trigger: 'auto-timer' } }), now).label).toBe(
      'Sync (automatic)',
    );
    expect(describeCommand(cmd({ status: 'pending', payload: { full: true } }), now).label).toBe(
      'Sync (full rescan)',
    );
    expect(
      describeCommand(cmd({ kind: 'probe', status: 'pending', payload: { trigger: 'auto-timer' } }), now)
        .label,
    ).toBe('Session check');
  });

  it('done sync shows result.summary', () => {
    const d = describeCommand(cmd({ status: 'done', result: { summary: '3 imported' } }), now);
    expect(d).toEqual({ label: 'Sync', text: 'done 5m ago: 3 imported', tone: 'ok' });
  });

  it('done open_login (already signed in) shows the session label', () => {
    const d = describeCommand(
      cmd({
        kind: 'open_login',
        status: 'done',
        result: { sessionStatus: 'valid', outcome: 'already-signed-in' },
      }),
      now,
    );
    expect(d.text).toBe('done 5m ago: Signed in');
  });

  it('done with nothing to say has no trailing colon', () => {
    expect(describeCommand(cmd({ status: 'done' }), now).text).toBe('done 5m ago');
  });
});
