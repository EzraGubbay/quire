'use client';

import { Icon } from '@ezragubbay/folio';
import { ANNOTATION_TYPE_LABEL, ANNOTATION_TYPES, type Anchor, type AnnotationType } from '@quire/shared';
import { Crosshair, PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation } from '@/db/schema';
import { fuzzyScore } from '@/lib/fuzzy';
import s from './annotations.module.css';

const typeVars = (t: AnnotationType) =>
  ({ '--hl': `var(--folio-hl-${t})`, '--hl-text': `var(--folio-hl-${t}-text)` }) as React.CSSProperties;

export interface AnnotationsPanelProps {
  annotations: Annotation[];
  collapsed: boolean;
  onToggle: () => void;
  activeId: string | null;
  onHover: (id: string | null) => void;
  onScrollTo: (a: Annotation) => void;
  onAddGeneral: () => void;
  onChangeType: (id: string, type: AnnotationType) => void;
  onChangeBody: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  /** Id of the annotation whose body should start focused (just created). */
  focusId: string | null;
}

export function AnnotationsPanel({
  annotations,
  collapsed,
  onToggle,
  activeId,
  onHover,
  onScrollTo,
  onAddGeneral,
  onChangeType,
  onChangeBody,
  onDelete,
  focusId,
}: AnnotationsPanelProps) {
  const [filter, setFilter] = useState<AnnotationType | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const visible = useMemo(() => {
    const scored = annotations
      .filter((a) => !filter || a.type === filter)
      .map((a) => ({ a, score: query ? Math.max(fuzzyScore(query, a.body), fuzzyScore(query, a.quote)) : 1 }))
      .filter((x) => x.score > 0);
    if (query) scored.sort((x, y) => y.score - x.score);
    return scored.map((x) => x.a);
  }, [annotations, filter, query]);

  if (collapsed) {
    return (
      <aside className={s.panel} data-collapsed="true" aria-label="Annotations">
        <div className={s.panelHead} style={{ justifyContent: 'center', padding: 8 }}>
          <button type="button" className={s.iconBtn} aria-label="Show annotations" onClick={onToggle}>
            <Icon icon={PanelRightOpen} />
          </button>
        </div>
        <button type="button" className={s.collapsedBtn} onClick={onToggle}>
          Annotations · {annotations.length}
        </button>
      </aside>
    );
  }

  return (
    <aside className={s.panel} aria-label="Annotations">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>Annotations · {annotations.length}</h2>
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
      <div className={s.tools}>
        <div className={s.filters} role="group" aria-label="Filter by type">
          {ANNOTATION_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={s.filter}
              style={typeVars(t)}
              data-active={filter === t}
              aria-pressed={filter === t}
              onClick={() => setFilter((f) => (f === t ? null : t))}
            >
              {ANNOTATION_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <input
          className={s.search}
          type="search"
          placeholder="Search annotations"
          aria-label="Search annotations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={s.list}>
        {visible.length === 0 ? (
          <p className={s.empty}>
            {annotations.length === 0
              ? 'Select text in the document and press Annotate, or use + for a general note.'
              : 'No annotations match.'}
          </p>
        ) : (
          visible.map((a) => (
            <AnnotationCard
              key={a.id}
              a={a}
              active={a.id === activeId}
              expanded={expanded === a.id}
              autoFocus={a.id === focusId}
              onHover={onHover}
              onToggleExpand={() => setExpanded((e) => (e === a.id ? null : a.id))}
              onScrollTo={() => onScrollTo(a)}
              onChangeType={(t) => onChangeType(a.id, t)}
              onChangeBody={(b) => onChangeBody(a.id, b)}
              onDelete={() => onDelete(a.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function AnnotationCard({
  a,
  active,
  expanded,
  autoFocus,
  onHover,
  onToggleExpand,
  onScrollTo,
  onChangeType,
  onChangeBody,
  onDelete,
}: {
  a: Annotation;
  active: boolean;
  expanded: boolean;
  autoFocus: boolean;
  onHover: (id: string | null) => void;
  onToggleExpand: () => void;
  onScrollTo: () => void;
  onChangeType: (t: AnnotationType) => void;
  onChangeBody: (b: string) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(a.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const anchor = a.anchor as Anchor | null;

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== a.body) onChangeBody(draft);
  };

  return (
    <div
      className={s.card}
      style={typeVars(a.type)}
      data-active={active}
      data-expanded={expanded || editing}
      data-testid="annotation-card"
      onMouseEnter={() => onHover(a.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea')) return;
        if (!editing) onToggleExpand();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onToggleExpand();
      }}
      tabIndex={0}
    >
      <div className={s.cardHead}>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className={s.typeBtn}
            aria-haspopup="listbox"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            {ANNOTATION_TYPE_LABEL[a.type]}
          </button>
          {menu && (
            <div
              className={s.menu}
              role="listbox"
              aria-label="Annotation type"
              onMouseLeave={() => setMenu(false)}
            >
              {ANNOTATION_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="option"
                  aria-selected={t === a.type}
                  className={s.menuItem}
                  data-selected={t === a.type}
                  style={typeVars(t)}
                  onClick={() => {
                    setMenu(false);
                    if (t !== a.type) onChangeType(t);
                  }}
                >
                  <span className={s.dot} />
                  {ANNOTATION_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
        </div>
        {a.pageNo && <span className={s.page}>p.{a.pageNo}</span>}
        {!anchor && <span className={s.page}>general</span>}
        <span className={s.spacer} />
        {anchor && active && (
          <button
            type="button"
            className={s.iconBtn}
            aria-label="Scroll to this passage"
            title="Scroll to this passage"
            onClick={onScrollTo}
          >
            <Icon icon={Crosshair} />
          </button>
        )}
        <button
          type="button"
          className={s.iconBtn}
          aria-label="Delete annotation"
          title="Delete annotation"
          onClick={onDelete}
        >
          <Icon icon={Trash2} />
        </button>
      </div>
      {a.quote && <div className={s.quote}>“{a.quote}”</div>}
      {editing ? (
        <textarea
          ref={textareaRef}
          className={s.bodyEdit}
          aria-label="Annotation text"
          value={draft}
          placeholder="Write your note…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(a.body);
              setEditing(false);
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
      ) : (
        <div
          className={s.body}
          onDoubleClick={() => {
            setDraft(a.body);
            setEditing(true);
          }}
          style={a.body ? undefined : { color: 'var(--eg-muted)' }}
        >
          {a.body || 'Double-click to write…'}
        </div>
      )}
    </div>
  );
}
