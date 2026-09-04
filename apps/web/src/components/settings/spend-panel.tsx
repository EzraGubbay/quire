import type { SpendSummary } from '@/lib/ai/ledger';
import s from './settings.module.css';

/** The spend view alone, for the phone's lite settings. */
export function SpendPanel({ summary, configured }: { summary: SpendSummary; configured: boolean }) {
  return (
    <section className={s.section}>
      <h2 className={s.h2}>AI spend</h2>
      <div className={s.spend} data-testid="spend">
        <div className={s.spendBig}>
          <span>${summary.monthToDate.toFixed(2)}</span>
          <span className={s.help}>
            of ${summary.cap.toFixed(2)} this month · resets {summary.resetsOn}
          </span>
        </div>
        <div
          className={s.meter}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Math.min(1, summary.fraction)}
        >
          <div
            className={s.meterFill}
            data-state={summary.state}
            style={{ width: `${Math.min(100, summary.fraction * 100)}%` }}
          />
        </div>
        {!configured && <p className={s.help}>No API key on the server.</p>}
      </div>
    </section>
  );
}
