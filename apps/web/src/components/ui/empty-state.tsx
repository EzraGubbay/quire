import type { ReactNode } from 'react';
import s from './ui.module.css';

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <h2 className={s.emptyTitle}>{title}</h2>
      {children && <p className={s.emptyBody}>{children}</p>}
      {actions && <div className={s.emptyActions}>{actions}</div>}
    </div>
  );
}
