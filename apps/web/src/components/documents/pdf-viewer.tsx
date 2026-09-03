'use client';

import type { AnnotationType, PdfAnchor } from '@quire/shared';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import s from './pdf-viewer.module.css';

type Pdfjs = typeof import('pdfjs-dist');
type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;
type PdfPage = import('pdfjs-dist').PDFPageProxy;

export interface PdfHighlight {
  id: string;
  type: AnnotationType;
  anchor: PdfAnchor;
}

/** A user text selection inside one page, in scale-1 CSS pixels with a top-left origin. */
export interface PdfSelection {
  anchor: PdfAnchor;
  /** Viewport-space box of the selection at the current scale, relative to the viewer, for placing a popover. */
  box: { top: number; left: number; width: number; height: number };
}

export interface PdfViewerHandle {
  scrollToPage: (page: number) => void;
  scrollToAnchor: (anchor: PdfAnchor) => void;
}

export interface PdfViewerProps {
  fileUrl: string;
  initialPage?: number;
  highlights?: PdfHighlight[];
  activeHighlightId?: string | null;
  onProgress?: (page: number, pageCount: number) => void;
  onSelection?: (sel: PdfSelection | null) => void;
  ref?: React.Ref<PdfViewerHandle>;
}

const WORKER_URL = '/pdf.worker.min.mjs';
let pdfjsPromise: Promise<Pdfjs> | undefined;
function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return m;
    });
  }
  return pdfjsPromise;
}

interface PageState {
  no: number;
  page: PdfPage;
  /** Width/height at scale 1. */
  w: number;
  h: number;
}

export function PdfViewer({
  fileUrl,
  initialPage = 1,
  highlights = [],
  activeHighlightId,
  onProgress,
  onSelection,
  ref,
}: PdfViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<Pdfjs | null>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [scale, setScale] = useState(1);
  const [current, setCurrent] = useState(initialPage);
  const [error, setError] = useState<string | null>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const didInitialScroll = useRef(false);

  // Load the document and page sizes.
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    (async () => {
      try {
        const lib = await loadPdfjs();
        const d = await lib.getDocument({ url: fileUrl }).promise;
        if (cancelled) {
          d.destroy();
          return;
        }
        loaded = d;
        const list: PageState[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const page = await d.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          list.push({ no: i, page, w: vp.width, h: vp.height });
        }
        if (cancelled) return;
        setPdfjs(lib);
        setDoc(d);
        setPages(list);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [fileUrl]);

  // Fit to width.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el || pages.length === 0) return;
    const fit = () => {
      const maxW = Math.max(...pages.map((p) => p.w));
      const available = el.clientWidth - 48;
      setScale(Math.min(2, Math.max(0.5, available / maxW)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages]);

  // Current page tracking.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el || pages.length === 0) return;
    const visible = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const no = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) visible.set(no, e.intersectionRatio);
          else visible.delete(no);
        }
        if (visible.size === 0) return;
        const best = [...visible.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
        if (best) setCurrent(best);
      },
      { root: el, threshold: [0.1, 0.3, 0.5, 0.7, 0.9] },
    );
    for (const node of pageEls.current.values()) io.observe(node);
    return () => io.disconnect();
  }, [pages]);

  useEffect(() => {
    if (pages.length > 0) onProgress?.(current, pages.length);
  }, [current, pages.length, onProgress]);

  const scrollToPage = useCallback((page: number) => {
    pageEls.current.get(page)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const scrollToAnchor = useCallback(
    (anchor: PdfAnchor) => {
      const el = pageEls.current.get(anchor.page);
      const viewer = viewerRef.current;
      if (!el || !viewer) return;
      const first = anchor.rects[0];
      const y = el.offsetTop + (first ? first.y * scale : 0) - 80;
      viewer.scrollTo({ top: y, behavior: 'smooth' });
    },
    [scale],
  );

  useImperativeHandle(ref, () => ({ scrollToPage, scrollToAnchor }), [scrollToPage, scrollToAnchor]);

  // Initial scroll once pages have real size.
  useEffect(() => {
    if (didInitialScroll.current || pages.length === 0 || initialPage <= 1) return;
    didInitialScroll.current = true;
    requestAnimationFrame(() => pageEls.current.get(initialPage)?.scrollIntoView({ block: 'start' }));
  }, [pages, initialPage]);

  // Selection → anchor.
  useEffect(() => {
    if (!onSelection) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        onSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const pageEl = (
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement
      )?.closest<HTMLElement>('[data-page]');
      if (!pageEl || !viewer.contains(pageEl)) {
        onSelection(null);
        return;
      }
      const layer = pageEl.querySelector<HTMLElement>('.textLayer');
      if (!layer) return;
      const quote = sel.toString().replace(/\s+/g, ' ').trim();
      if (!quote) {
        onSelection(null);
        return;
      }
      const { start, end, prefix, suffix } = offsetsIn(layer, range, quote.length);
      const pageRect = pageEl.getBoundingClientRect();
      const rects = mergeRects(
        [...range.getClientRects()].map((r) => ({
          x: (r.left - pageRect.left) / scale,
          y: (r.top - pageRect.top) / scale,
          w: r.width / scale,
          h: r.height / scale,
        })),
      );
      const viewerRect = viewer.getBoundingClientRect();
      const b = range.getBoundingClientRect();
      onSelection({
        anchor: { kind: 'pdf', page: Number(pageEl.dataset.page), quote, prefix, suffix, start, end, rects },
        box: {
          top: b.top - viewerRect.top + viewer.scrollTop,
          left: b.left - viewerRect.left + viewer.scrollLeft,
          width: b.width,
          height: b.height,
        },
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onSelection, scale]);

  if (error) return <div className={s.loading}>Could not load the PDF: {error}</div>;

  return (
    <div className={s.viewer} ref={viewerRef}>
      {pages.length === 0 ? (
        <div className={s.loading}>Loading PDF…</div>
      ) : (
        <div className={s.pages}>
          {pages.map((p) => (
            <Page
              key={p.no}
              state={p}
              scale={scale}
              pdfjs={pdfjs!}
              doc={doc!}
              highlights={highlights.filter((h) => h.anchor.page === p.no)}
              activeHighlightId={activeHighlightId ?? null}
              register={(el) => {
                if (el) pageEls.current.set(p.no, el);
                else pageEls.current.delete(p.no);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Character offsets of `range` within the text layer's concatenated span text, plus short context strings. */
function offsetsIn(layer: HTMLElement, range: Range, quoteLen: number) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let full = '';
  let start = -1;
  let n: Node | null = walker.nextNode();
  while (n) {
    if (n === range.startContainer) start = full.length + range.startOffset;
    full += n.textContent ?? '';
    n = walker.nextNode();
  }
  if (start < 0) start = 0;
  const end = Math.min(full.length, start + quoteLen);
  return {
    start,
    end,
    prefix: full.slice(Math.max(0, start - 32), start),
    suffix: full.slice(end, end + 32),
  };
}

/** Collapses the many small client rects of a selection into one rect per visual line. */
function mergeRects(rects: { x: number; y: number; w: number; h: number }[]) {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const r of rects.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5) {
      const x1 = Math.min(last.x, r.x);
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      last.x = x1;
      last.w = x2 - x1;
      last.h = Math.max(last.h, r.h);
    } else out.push({ ...r });
  }
  return out;
}

function Page({
  state,
  scale,
  pdfjs,
  doc,
  highlights,
  activeHighlightId,
  register,
}: {
  state: PageState;
  scale: number;
  pdfjs: Pdfjs;
  doc: PdfDocument;
  highlights: PdfHighlight[];
  activeHighlightId: string | null;
  register: (el: HTMLDivElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: '600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!canvas || !layer) return;
    let cancelled = false;
    const viewport = state.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const renderTask = state.page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    layer.replaceChildren();
    layer.style.setProperty('--scale-factor', String(scale));
    layer.style.setProperty('--total-scale-factor', String(scale));
    const textLayer = new pdfjs.TextLayer({
      textContentSource: state.page.streamTextContent(),
      container: layer,
      viewport,
    });
    renderTask.promise.catch(() => {});
    textLayer.render().catch(() => {});
    return () => {
      cancelled = true;
      renderTask.cancel();
      textLayer.cancel();
      void cancelled;
      void doc;
    };
  }, [visible, scale, state.page, pdfjs, doc]);

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        register(el);
      }}
      className={s.page}
      data-page={state.no}
      style={{ width: state.w * scale, height: state.h * scale }}
    >
      <canvas ref={canvasRef} />
      <div ref={layerRef} className="textLayer" />
      <div className={s.highlights}>
        {highlights.flatMap((h) =>
          h.anchor.rects.map((r, i) => (
            <div
              key={`${h.id}-${i}`}
              className={s.hl}
              data-active={h.id === activeHighlightId ? 'true' : undefined}
              style={
                {
                  left: r.x * scale,
                  top: r.y * scale,
                  width: r.w * scale,
                  height: r.h * scale,
                  '--hl': `var(--folio-hl-${h.type})`,
                  '--hl-text': `var(--folio-hl-${h.type}-text)`,
                } as React.CSSProperties
              }
            />
          )),
        )}
      </div>
      <span className={s.pageNo}>{state.no}</span>
    </div>
  );
}
