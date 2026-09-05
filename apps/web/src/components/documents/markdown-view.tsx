'use client';

import { Prose } from '@ezragubbay/folio';
import type { AnnotationType, MarkdownAnchor } from '@quire/shared';
import { MathJax } from 'better-react-mathjax';
import { memo, useEffect, useMemo, useRef } from 'react';
import { anchorFromSelection, locateQuote } from '@/lib/text-anchor';
import s from './markdown-view.module.css';
import { pinchMath, usePinch } from './use-pinch';

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.6;
const BASE_TEXT_PX = 17.5;

export interface MarkdownHighlight {
  id: string;
  type: AnnotationType;
  anchor: MarkdownAnchor;
}

export interface MarkdownSelection {
  anchor: MarkdownAnchor;
  box: { top: number; left: number; width: number; height: number };
}

export interface MarkdownViewHandle {
  scrollToAnchor: (anchor: MarkdownAnchor) => void;
  scrollToTop: () => void;
}

interface Props {
  html: string;
  highlights?: MarkdownHighlight[];
  activeHighlightId?: string | null;
  onSelection?: (sel: MarkdownSelection | null) => void;
  onWikiLink?: (name: string) => void;
  /** Text size multiplier (reader zoom for reflowing text). */
  fontScale?: number;
  onFontScale?: (next: number) => void;
  /** Touch pinch / double-tap change the text size; single tap reports up (reader chrome). */
  pinch?: boolean;
  onTap?: () => void;
  onScroll?: () => void;
  /** Reading position as a fraction of the scroll range. */
  onProgress?: (fraction: number) => void;
  ref?: React.Ref<MarkdownViewHandle>;
}

const TYPES: AnnotationType[] = ['note', 'insight', 'idea', 'question', 'todo'];
const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS;

/** Rendered Markdown with MathJax typesetting, wiki-link clicks, and annotation highlights via the CSS Highlight API. */
export const MarkdownView = memo(function MarkdownView({
  html,
  highlights = [],
  activeHighlightId,
  onSelection,
  onWikiLink,
  fontScale = 1,
  onFontScale,
  pinch = false,
  onTap,
  onScroll,
  onProgress,
  ref,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ranges = useRef(new Map<string, Range>());
  const suppressScrollUntil = useRef(0);

  usePinch(
    wrapRef,
    {
      onCommit: (ratio) => onFontScale?.(pinchMath.clamp(fontScale * ratio, FONT_SCALE_MIN, FONT_SCALE_MAX)),
      onDoubleTap: () => onFontScale?.(fontScale > 1.05 ? 1 : 1.25),
      onTap: () => onTap?.(),
    },
    pinch,
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || (!onScroll && !onProgress)) return;
    const handler = () => {
      const range = el.scrollHeight - el.clientHeight;
      onProgress?.(range > 0 ? pinchMath.clamp(el.scrollTop / range, 0, 1) : 1);
      if (Date.now() >= suppressScrollUntil.current) onScroll?.();
    };
    const range = el.scrollHeight - el.clientHeight;
    onProgress?.(range > 0 ? pinchMath.clamp(el.scrollTop / range, 0, 1) : 1);
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [onScroll, onProgress]);

  // Paint highlights. One registry entry per type plus one for the active card.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !supportsHighlights()) return;
    const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    ranges.current.clear();
    for (const t of TYPES) {
      const rs = highlights
        .filter((h) => h.type === t)
        .map((h) => {
          const r = locateQuote(root, h.anchor);
          if (r) ranges.current.set(h.id, r);
          return r;
        })
        .filter((r): r is Range => Boolean(r));
      reg.set(`quire-${t}`, new H(...rs));
    }
    const active = activeHighlightId ? ranges.current.get(activeHighlightId) : undefined;
    reg.set('quire-active', new H(...(active ? [active] : [])));
    return () => {
      for (const t of TYPES) reg.delete(`quire-${t}`);
      reg.delete('quire-active');
    };
  }, [html, highlights, activeHighlightId]);

  // Selection → anchor.
  useEffect(() => {
    if (!onSelection) return;
    const handler = () => {
      const root = rootRef.current;
      const wrap = wrapRef.current;
      const sel = window.getSelection();
      if (!root || !wrap || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        onSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        onSelection(null);
        return;
      }
      const anchor = anchorFromSelection(root, range);
      if (!anchor) {
        onSelection(null);
        return;
      }
      const b = range.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      onSelection({
        anchor,
        box: {
          top: b.top - w.top,
          left: b.left - w.left,
          width: b.width,
          height: b.height,
        },
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onSelection]);

  useEffect(() => {
    if (!ref) return;
    const handle: MarkdownViewHandle = {
      scrollToAnchor: (anchor) => {
        const root = rootRef.current;
        if (!root) return;
        const r = locateQuote(root, anchor);
        const el = r?.startContainer.parentElement;
        suppressScrollUntil.current = Date.now() + 1000;
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
      scrollToTop: () => {
        suppressScrollUntil.current = Date.now() + 1000;
        wrapRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      },
    };
    if (typeof ref === 'function') ref(handle);
    else (ref as React.MutableRefObject<MarkdownViewHandle | null>).current = handle;
  }, [ref]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-wikilink]');
    if (a) {
      e.preventDefault();
      onWikiLink?.(a.dataset.wikilink ?? '');
    }
  };

  const body = useMemo(
    () => (
      <div ref={rootRef} className={s.body} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    ),
    [html],
  );

  return (
    <div
      ref={wrapRef}
      className={s.wrap}
      data-testid="markdown-view"
      style={{ '--folio-text-body': `${(BASE_TEXT_PX * fontScale).toFixed(1)}px` } as React.CSSProperties}
    >
      <Prose>
        {/* Typeset once per HTML change (key), never on re-render: re-typesetting rewrites the DOM and drops the user's selection. */}
        <MathJax key={html} hideUntilTypeset="first">
          {body}
        </MathJax>
      </Prose>
    </div>
  );
});
