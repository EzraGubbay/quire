'use client';

import { Icon } from '@ezragubbay/folio';
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import s from './annotations.module.css';
import { AnnotationsList, type AnnotationsListProps } from './annotations-list';

export interface AnnotationsPanelProps extends AnnotationsListProps {
  collapsed: boolean;
  onToggle: () => void;
  onAddGeneral: () => void;
}

/** Desktop/tablet side panel: collapsible aside around the shared annotations list. */
export function AnnotationsPanel({ collapsed, onToggle, onAddGeneral, ...list }: AnnotationsPanelProps) {
  if (collapsed) {
    return (
      <aside className={s.panel} data-collapsed="true" aria-label="Annotations">
        <div className={s.panelHead} style={{ justifyContent: 'center', padding: 8 }}>
          <button type="button" className={s.iconBtn} aria-label="Show annotations" onClick={onToggle}>
            <Icon icon={PanelRightOpen} />
          </button>
        </div>
        <button type="button" className={s.collapsedBtn} onClick={onToggle}>
          Annotations · {list.annotations.length}
        </button>
      </aside>
    );
  }

  return (
    <aside className={s.panel} aria-label="Annotations">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>Annotations · {list.annotations.length}</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className={s.iconBtn}
            aria-label="Add a general annotation"
            title="Add a general annotation"
            onClick={onAddGeneral}
          >
            <Icon icon={Plus} />
          </button>
          <button type="button" className={s.iconBtn} aria-label="Hide annotations" onClick={onToggle}>
            <Icon icon={PanelRightClose} />
          </button>
        </div>
      </div>
      <AnnotationsList {...list} />
    </aside>
  );
}
