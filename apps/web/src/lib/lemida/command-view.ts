// Pure, client-safe description of a Lemida command for the panel (no DB imports).
import type { LemidaCommandKind, LemidaCommandStatus } from '@quire/shared';

export interface CommandView {
  id: string;
  kind: LemidaCommandKind;
  status: LemidaCommandStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CommandTone = 'neutral' | 'ok' | 'error';

const KIND_LABEL: Record<LemidaCommandKind, string> = {
  open_login: 'Sign in',
  probe: 'Session check',
  sync: 'Sync',
};

const SESSION_LABEL: Record<string, string> = {
  valid: 'Signed in',
  expired: 'Signed out',
  unknown: 'Unknown',
};

const MAX_TEXT = 300;

function agoText(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'a while ago';
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function describeCommand(
  c: CommandView,
  now: Date,
): { label: string; text: string; tone: CommandTone } {
  let label = KIND_LABEL[c.kind] ?? c.kind;
  if (c.kind === 'sync') {
    if (str(c.payload.trigger).startsWith('auto')) label += ' (automatic)';
    if (c.payload.full === true) label += ' (full rescan)';
  }
  switch (c.status) {
    case 'pending':
      return {
        label,
        text: `waiting for the desktop app · queued ${agoText(c.createdAt, now)}`,
        tone: 'neutral',
      };
    case 'running':
      return {
        label,
        text: `running on your Mac · started ${agoText(c.updatedAt, now)}`,
        tone: 'neutral',
      };
    case 'done': {
      const detail =
        str(c.result.summary) || str(c.result.message) || SESSION_LABEL[str(c.result.sessionStatus)] || '';
      return {
        label,
        text: `done ${agoText(c.updatedAt, now)}${detail ? `: ${cut(detail)}` : ''}`,
        tone: 'ok',
      };
    }
    default:
      return {
        label,
        text: `failed ${agoText(c.updatedAt, now)}: ${cut(str(c.result.message) || 'no details')}`,
        tone: 'error',
      };
  }
}
