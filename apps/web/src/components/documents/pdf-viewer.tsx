'use client';

import type { AnnotationType, PdfAnchor } from '@quire/shared';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { deviceInfo, isDebug, log, setCrashMark } from '@/lib/debug-client';
import { installPdfPolyfills } from '@/lib/pdf-polyfill';
import s from './pdf-viewer.module.css';
import { type Point, pinchMath, usePinch } from './use-pinch';

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
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
  scrollToTop: () => void;
  /** Zoom relative to fit-to-width (1 = fit). */
  setZoom: (zoom: number, focal?: Point) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
}

export interface PdfViewerProps {
  fileUrl: string;
  initialPage?: number;
  highlights?: PdfHighlight[];
  activeHighlightId?: string | null;
  onProgress?: (page: number, pageCount: number) => void;
  onSelection?: (sel: PdfSelection | null) => void;
  /** Cap on the render pixel ratio (Safari limits total canvas memory; phones use 1.5). */
  maxPixelRatio?: number;
  /** Pages beyond viewport ± this many are released (canvas freed) until they come back. */
  renderWindow?: number;
  /** Build the selectable text layer (off in lite mode: fewer DOM nodes, less memory). */
  textLayer?: boolean;
  /** Zoom bounds relative to fit-to-width. */
  minZoom?: number;
  maxZoom?: number;
  /** Horizontal room left around a fitted page. */
  fitPadding?: number;
  /** Cap on canvas pixels per page; the pixel ratio drops to stay under it (phones: 6 MP). */
  maxCanvasPixels?: number;
  /** Touch pinch and double-tap zoom, single-tap callback. */
  pinch?: boolean;
  onZoomChange?: (zoom: number) => void;
  onTap?: () => void;
  /** User-initiated scrolling (programmatic scrolls are filtered out). */
  onScroll?: () => void;
  ref?: React.Ref<PdfViewerHandle>;
}

const WORKER_URL = '/pdf.worker.min.mjs';
let pdfjsPromise: Promise<Pdfjs> | undefined;
function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    installPdfPolyfills();
    // The legacy build carries polyfills for engines a release or two behind (iOS Safari); the modern build does not.
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
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
  maxPixelRatio = 2,
  renderWindow = 1,
  textLayer = true,
  minZoom = 0.5,
  maxZoom = 3,
  fitPadding = 48,
  maxCanvasPixels = 16_000_000,
  pinch = false,
  onZoomChange,
  onTap,
  onScroll,
  ref,
}: PdfViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pdfjs, setPdfjs] = useState<Pdfjs | null>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [fit, setFit] = useState(1);
  const [zoom, setZoomState] = useState(1);
  const scale = fit * zoom;
  const [current, setCurrent] = useState(initialPage);
  /** Scroll correction to apply once the layout reflects a new scale: keep `mid` over the same content. */
  const pendingScroll = useRef<{ ratio: number; mid: Point } | null>(null);
  /** Programmatic scrolls (scroll-to, zoom re-centre) must not count as user scrolling. */
  const suppressScrollUntil = useRef(0);
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
        log('info', 'viewer', 'loading document', { fileUrl, ...deviceInfo() });
        const t0 = performance.now();
        const d = await lib.getDocument({ url: fileUrl }).promise;
        log('info', 'viewer', 'document loaded', {
          pages: d.numPages,
          ms: Math.round(performance.now() - t0),
        });
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
        log('error', 'viewer', 'document load failed', err);
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
    const fitWidth = () => {
      const maxW = Math.max(...pages.map((p) => p.w));
      const available = el.clientWidth - fitPadding;
      setFit(Math.min(2, Math.max(0.5, available / maxW)));
    };
    fitWidth();
    const ro = new ResizeObserver(fitWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages, fitPadding]);

  // Zoom: commit a new factor, then (in the layout effect below) keep the focal point still.
  const applyZoom = useCallback(
    (next: number, focal?: Point) => {
      const el = viewerRef.current;
      const clamped = pinchMath.clamp(next, minZoom, maxZoom);
      setZoomState((z) => {
        if (Math.abs(clamped - z) < 0.001) return z;
        const mid = focal ?? (el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 });
        pendingScroll.current = { ratio: clamped / z, mid };
        log('debug', 'viewer', 'zoom', { zoom: Number(clamped.toFixed(2)), fit: Number(fit.toFixed(3)) });
        return clamped;
      });
    },
    [minZoom, maxZoom, fit],
  );
  useEffect(() => onZoomChange?.(zoom), [zoom, onZoomChange]);
  useLayoutEffect(() => {
    const el = viewerRef.current;
    const p = pendingScroll.current;
    if (!el || !p) return;
    pendingScroll.current = null;
    suppressScrollUntil.current = Date.now() + 400;
    el.scrollLeft = pinchMath.scrollAfterZoom(el.scrollLeft, p.mid.x, p.ratio);
    el.scrollTop = pinchMath.scrollAfterZoom(el.scrollTop, p.mid.y, p.ratio);
  }, [scale]);

  usePinch(
    viewerRef,
    {
      onPreview: (ratio, mid) => {
        const pages = pagesRef.current;
        const el = viewerRef.current;
        if (!pages || !el) return;
        const ox = mid.x + el.scrollLeft - pages.offsetLeft;
        const oy = mid.y + el.scrollTop - pages.offsetTop;
        pages.style.transformOrigin = `${ox}px ${oy}px`;
        pages.style.transform = `scale(${ratio})`;
      },
      onCommit: (ratio, mid) => {
        const pages = pagesRef.current;
        if (pages) {
          pages.style.transform = '';
          pages.style.transformOrigin = '';
        }
        applyZoom(zoom * ratio, mid);
      },
      onDoubleTap: (point) => applyZoom(zoom > 1.05 ? 1 : 2, point),
      onTap: () => onTap?.(),
    },
    pinch,
  );

  // User scrolling (for hiding reader chrome); programmatic scrolls are suppressed for a short window.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el || !onScroll) return;
    const handler = () => {
      if (Date.now() < suppressScrollUntil.current) return;
      onScroll();
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [onScroll]);

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
    if (pages.length > 0 && isDebug()) {
      const live = liveCanvasBytes();
      log('debug', 'viewer', 'current page', {
        page: current,
        of: pages.length,
        scale: Number(scale.toFixed(3)),
        liveCanvasMB: Number((live / 1048576).toFixed(1)),
        renderedPages: document.querySelectorAll('[data-rendered="true"]').length,
      });
      setCrashMark({
        fileUrl,
        page: current,
        of: pages.length,
        scale: Number(scale.toFixed(3)),
        liveCanvasMB: Number((live / 1048576).toFixed(1)),
      });
    }
  }, [current, pages.length, onProgress, scale, fileUrl]);
  useEffect(() => () => setCrashMark(null), []);

  const scrollToPage = useCallback((page: number) => {
    suppressScrollUntil.current = Date.now() + 1000;
    pageEls.current.get(page)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const scrollToTop = useCallback(() => {
    suppressScrollUntil.current = Date.now() + 1000;
    viewerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToAnchor = useCallback(
    (anchor: PdfAnchor) => {
      const el = pageEls.current.get(anchor.page);
      const viewer = viewerRef.current;
      if (!el || !viewer) return;
      const first = anchor.rects[0];
      const y = el.offsetTop + (first ? first.y * scale : 0) - 80;
      suppressScrollUntil.current = Date.now() + 1000;
      viewer.scrollTo({ top: y, behavior: 'smooth' });
    },
    [scale],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      scrollToAnchor,
      scrollToTop,
      setZoom: applyZoom,
      zoomIn: () => applyZoom(zoom * 1.25),
      zoomOut: () => applyZoom(zoom / 1.25),
      fitWidth: () => applyZoom(1),
    }),
    [scrollToPage, scrollToAnchor, scrollToTop, applyZoom, zoom],
  );

  // Initial scroll once pages have real size.
  useEffect(() => {
    if (didInitialScroll.current || pages.length === 0 || initialPage <= 1) return;
    didInitialScroll.current = true;
    suppressScrollUntil.current = Date.now() + 1000;
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
    <div className={s.viewer} ref={viewerRef} data-testid="pdf-viewer" data-zoom={zoom.toFixed(2)}>
      {pages.length === 0 ? (
        <div className={s.loading}>Loading PDF…</div>
      ) : (
        <div className={s.pages} ref={pagesRef}>
          {pages.map((p) => (
            <Page
              key={p.no}
              state={p}
              scale={scale}
              pdfjs={pdfjs!}
              doc={doc!}
              highlights={highlights.filter((h) => h.anchor.page === p.no)}
              activeHighlightId={activeHighlightId ?? null}
              maxPixelRatio={maxPixelRatio}
              maxCanvasPixels={maxCanvasPixels}
              current={current}
              renderWindow={renderWindow}
              scrollRoot={viewerRef.current}
              textLayer={textLayer}
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
  maxPixelRatio,
  maxCanvasPixels,
  current,
  renderWindow,
  scrollRoot,
  textLayer,
}: {
  state: PageState;
  scale: number;
  pdfjs: Pdfjs;
  doc: PdfDocument;
  highlights: PdfHighlight[];
  activeHighlightId: string | null;
  register: (el: HTMLDivElement | null) => void;
  maxPixelRatio: number;
  maxCanvasPixels: number;
  current: number;
  renderWindow: number;
  scrollRoot: HTMLElement | null;
  textLayer: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      root: scrollRoot,
      rootMargin: '300px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  // Render while on screen or within the window around the current page; otherwise release the canvas so
  // Safari (which caps total canvas memory) can reclaim it. The container keeps its size, so scrolling is stable.
  const shouldRender = visible || Math.abs(state.no - current) <= renderWindow;

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!canvas || !layer) return;
    if (!shouldRender) {
      if (canvas.width > 0)
        log('debug', 'viewer', 'release page', {
          page: state.no,
          liveCanvasMB: mb(liveCanvasBytes() - canvas.width * canvas.height * 4),
        });
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '';
      canvas.style.height = '';
      layer.replaceChildren();
      return;
    }
    const viewport = state.page.getViewport({ scale });
    let dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    // Safari refuses canvases above ~16.7 million pixels, and total canvas memory is capped; stay under the budget.
    const maxPixels = Math.min(16_000_000, maxCanvasPixels);
    if (viewport.width * viewport.height * dpr * dpr > maxPixels)
      dpr = Math.max(0.5, Math.sqrt(maxPixels / (viewport.width * viewport.height)));
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    log('debug', 'viewer', 'render page', {
      page: state.no,
      css: `${Math.round(viewport.width)}x${Math.round(viewport.height)}`,
      canvas: `${canvas.width}x${canvas.height}`,
      dpr: Number(dpr.toFixed(2)),
      canvasMB: mb(canvas.width * canvas.height * 4),
      liveCanvasMB: mb(liveCanvasBytes()),
      textLayer,
    });
    const t0 = performance.now();
    const renderTask = state.page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    layer.replaceChildren();
    layer.style.setProperty('--scale-factor', String(scale));
    layer.style.setProperty('--total-scale-factor', String(scale));
    const text = textLayer
      ? new pdfjs.TextLayer({ textContentSource: state.page.streamTextContent(), container: layer, viewport })
      : null;
    renderTask.promise.then(
      () =>
        log('debug', 'viewer', 'page rendered', { page: state.no, ms: Math.round(performance.now() - t0) }),
      (err: unknown) => {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException')
          log('error', 'viewer', 'page render failed', { page: state.no, err });
      },
    );
    text
      ?.render()
      .catch((err: unknown) => log('warn', 'viewer', 'text layer failed', { page: state.no, err }));
    return () => {
      renderTask.cancel();
      text?.cancel();
      void doc;
    };
  }, [shouldRender, scale, state.page, pdfjs, doc, maxPixelRatio, maxCanvasPixels, textLayer]);

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        register(el);
      }}
      className={s.page}
      data-page={state.no}
      data-rendered={shouldRender ? 'true' : 'false'}
      style={{ width: state.w * scale, height: state.h * scale }}
    >
      <canvas ref={canvasRef} />
      <div ref={layerRef} className="textLayer" />
      {shouldRender && (
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
      )}
      <span className={s.pageNo}>{state.no}</span>
    </div>
  );
}

const mb = (bytes: number) => Number((bytes / 1048576).toFixed(1));

/** Sum of allocated canvas bytes in the viewer (width × height × 4), the number Safari's cap is about. */
function liveCanvasBytes(): number {
  let total = 0;
  for (const c of document.querySelectorAll('canvas')) total += c.width * c.height * 4;
  return total;
}
