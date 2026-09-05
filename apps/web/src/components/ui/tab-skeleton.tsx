import { currentPlatform } from '@/lib/platform-server';
import s from './ui.module.css';

/** Instant shell shown while a tab's data loads, so navigation feels immediate. Phones never show a rail. */
export async function TabSkeleton({ rail = false, title }: { rail?: boolean; title?: string }) {
  const phone = (await currentPlatform()) === 'phone';
  return (
    <div
      className={s.skelWrap}
      data-rail={rail && !phone}
      data-phone={phone ? 'true' : undefined}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {rail && !phone && <div className={s.skelRail} />}
      <div className={s.skelMain}>
        {title ? <h1 className={s.skelTitleText}>{title}</h1> : <div className={s.skelTitle} />}
        <div className={s.skelLine} style={{ width: '38%' }} />
        <div className={s.skelLine} style={{ width: '62%' }} />
        <div className={s.skelLine} style={{ width: '48%' }} />
      </div>
    </div>
  );
}
