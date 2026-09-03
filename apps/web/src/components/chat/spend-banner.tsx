import NextLink from 'next/link';
import type { SpendSummary } from '@/lib/ai/ledger';
import s from './chat.module.css';

/** Shown on every AI surface: nothing when fine, a warning past the threshold, a hard stop at the cap or a provider block. */
export function SpendBanner({ summary, configured }: { summary: SpendSummary; configured: boolean }) {
  if (!configured) {
    return (
      <div className={s.banner} data-state="unconfigured" role="status">
        AI is not configured on the server: set OPENAI_API_KEY in /srv/quire/.env and restart.
      </div>
    );
  }
  if (summary.state === 'ok') return null;
  const money = `$${summary.monthToDate.toFixed(2)} of $${summary.cap.toFixed(2)}`;
  return (
    <div className={s.banner} data-state={summary.state} role="status">
      {summary.state === 'warn' && <span>{money} of this month's AI budget used.</span>}
      {summary.state === 'capped' && (
        <span>
          Monthly AI budget reached ({money}). Resets {summary.resetsOn}.{' '}
          <NextLink href="/settings">Raise it in Settings.</NextLink>
        </span>
      )}
      {summary.state === 'blocked' && (
        <span>
          OpenAI is refusing requests: {summary.blockedMessage ?? 'budget exceeded on OpenAI’s side'}.{' '}
          <NextLink href="/settings">Retry from Settings.</NextLink>
        </span>
      )}
    </div>
  );
}
