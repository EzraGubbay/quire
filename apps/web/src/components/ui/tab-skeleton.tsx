import s from './ui.module.css';

/** Instant shell shown while a tab's data loads, so navigation feels immediate. */
export function TabSkeleton({ rail = false, title }: { rail?: boolean; title?: string }) {
  return (
    <div className={s.skelWrap} data-rail={rail} role="status" aria-busy="true" aria-label="Loading">
      {rail && <div className={s.skelRail} />}
      <div className={s.skelMain}>
        {title ? <h1 className={s.skelTitleText}>{title}</h1> : <div className={s.skelTitle} />}
        <div className={s.skelLine} style={{ width: '38%' }} />
        <div className={s.skelLine} style={{ width: '62%' }} />
        <div className={s.skelLine} style={{ width: '48%' }} />
      </div>
    </div>
  );
}
