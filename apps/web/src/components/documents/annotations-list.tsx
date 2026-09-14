'use client';

import { Icon } from '@ezragubbay/folio';
import { ANNOTATION_TYPE_LABEL, ANNOTATION_TYPES, type Anchor, type AnnotationType } from '@quire/shared';
import { MathJax } from 'better-react-mathjax';
import { Crosshair, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWikiLinkComplete } from '@/components/editor/wikilink-complete';
import type { Annotation } from '@/db/schema';
import { fuzzyScore } from '@/lib/fuzzy';
import { renderMarkdownClient } from '@/lib/markdown-client';
import s from './annotations.module.css';

export const typeVars = (t: AnnotationType) =>
  ({ '--hl': `var(--folio-hl-${t})`, '--hl-text': `var(--folio-hl-${t}-text)` }) as React.CSSProperties;

export interface AnnotationsListProps {
  annotations: Annotation[];
  activeId: string | null;
  onHover: (id: string | null) => void;
  onScrollTo: (a: Annotation) => void;
  onChangeType: (id: string, type: AnnotationType) => void;
  onChangeBody: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  /** A [[wiki link]] in a body was clicked. */
  onFollowLink: (name: string) => void;
  /** Titles offered after typing `[[` in a body. */
  linkTargets?: string[];
  /** Id of the annotation whose body should start focused (just created). */
  focusId: string | null;
  /** Phone reader: tapping an anchored card jumps to the passage instead of expanding it. */
  tapToScroll?: boolean;
  emptyHint?: string;
}

/** Type filters, fuzzy search and the card list. Shared by the side panel (desktop) and the bottom sheet (phone). */
export function AnnotationsList({
  annotations,
  activeId,
  onHover,
  onScrollTo,
  onChangeType,
  onChangeBody,
  onDelete,
  onFollowLink,
  linkTargets = [],
  focusId,
  tapToScroll = false,
  emptyHint = 'Select text in the document and press Annotate, or use + for a general note.',
}: AnnotationsListProps) {
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

  return (
    <>
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
          <p className={s.empty}>{annotations.length === 0 ? emptyHint : 'No annotations match.'}</p>
        ) : (
          visible.map((a) => (
            <AnnotationCard
              key={a.id}
              a={a}
              active={a.id === activeId}
              expanded={expanded === a.id}
              autoFocus={a.id === focusId}
              onHover={onHover}
              onToggleExpand={() => {
                if (tapToScroll && a.anchor) onScrollTo(a);
                else setExpanded((e) => (e === a.id ? null : a.id));
              }}
              tapToEdit={tapToScroll}
              onScrollTo={() => onScrollTo(a)}
              onChangeType={(t) => onChangeType(a.id, t)}
              onChangeBody={(b) => onChangeBody(a.id, b)}
              onDelete={() => onDelete(a.id)}
              onFollowLink={onFollowLink}
              linkTargets={linkTargets}
            />
          ))
        )}
      </div>
    </>
  );
}

function AnnotationCard({
  a,
  active,
  expanded,
  autoFocus,
  tapToEdit = false,
  onHover,
  onToggleExpand,
  onScrollTo,
  onChangeType,
  onChangeBody,
  onDelete,
  onFollowLink,
  linkTargets,
}: {
  a: Annotation;
  active: boolean;
  expanded: boolean;
  autoFocus: boolean;
  /** Touch: a tap on the body starts editing (no double-click on a phone). */
  tapToEdit?: boolean;
  onHover: (id: string | null) => void;
  onToggleExpand: () => void;
  onScrollTo: () => void;
  onChangeType: (t: AnnotationType) => void;
  onChangeBody: (b: string) => void;
  onDelete: () => void;
  onFollowLink: (name: string) => void;
  linkTargets: string[];
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(a.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const anchor = a.anchor as Anchor | null;

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const wiki = useWikiLinkComplete({ textareaRef, value: draft, targets: linkTargets, onChange: setDraft });

  const startEdit = () => {
    setDraft(a.body);
    setEditing(true);
    // A double-click also selects a word in the quote or body; the editor replaces that.
    window.getSelection()?.removeAllRanges();
  };
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
      // Keyboard focus counts as hover: the passage lights up and the hover-only buttons become reachable.
      onFocus={() => onHover(a.id)}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const link = target.closest<HTMLElement>('a[data-wikilink]');
        if (link) {
          e.preventDefault();
          onFollowLink(link.dataset.wikilink ?? '');
          return;
        }
        if (target.closest('button, textarea')) return;
        if (tapToEdit && target.closest('[data-body]')) {
          startEdit();
          return;
        }
        // The second click of a double-click must not undo the first one's expand.
        if (e.detail > 1) return;
        if (!editing) onToggleExpand();
      }}
      // Anywhere on the card: the first click expands and moves the body, so the body alone is a poor target.
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea, a, [role="listbox"]')) return;
        if (!editing) startEdit();
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
        {active && !editing && (
          <button
            type="button"
            className={s.iconBtn}
            aria-label="Edit annotation"
            title="Edit annotation"
            onClick={startEdit}
          >
            <Icon icon={Pencil} />
          </button>
        )}
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
        <div className={s.editWrap}>
          <textarea
            ref={textareaRef}
            className={s.bodyEdit}
            aria-label="Annotation text"
            value={draft}
            placeholder="Write your note… [[ links a document"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyUp={wiki.refresh}
            onClick={wiki.refresh}
            onKeyDown={(e) => {
              if (wiki.onKeyDown(e)) return;
              if (e.key === 'Escape') {
                setDraft(a.body);
                setEditing(false);
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
            }}
          />
          {wiki.list}
        </div>
      ) : (
        <div className={s.body} data-body style={a.body ? undefined : { color: 'var(--eg-muted)' }}>
          {a.body ? <BodyMarkdown text={a.body} /> : tapToEdit ? 'Tap to write…' : 'Double-click to write…'}
        </div>
      )}
    </div>
  );
}

/**
 * The body as Markdown: the same renderer as notes and documents (GFM, TeX math typeset by MathJax with the
 * project's macros, `[[wiki links]]` as anchors that the card's click handler follows). Falls back to the raw
 * text until the HTML is ready so the card never flashes empty.
 */
function BodyMarkdown({ text }: { text: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let live = true;
    renderMarkdownClient(text).then((h) => {
      if (live) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [text]);
  if (!html) return <span className={s.bodyPlain}>{text}</span>;
  return (
    <MathJax key={html} hideUntilTypeset="first">
      <div className={s.bodyProse} dangerouslySetInnerHTML={{ __html: html }} />
    </MathJax>
  );
}
