'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { Anchor, AnnotationType, MarkdownAnchor, PdfAnchor } from '@quire/shared';
import { ArrowLeft, MessageSquare, MessageSquarePlus, Minus, Pencil, Plus, Scan, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react';
import {
  createAnnotationAction,
  deleteAnnotationAction,
  updateAnnotationAction,
} from '@/app/actions/annotations';
import { deleteDocumentAction, updateDocumentAction } from '@/app/actions/documents';
import { followWikiLinkAction } from '@/app/actions/notes';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { Annotation, Document } from '@/db/schema';
import a11y from './annotations.module.css';
import { AnnotationsList } from './annotations-list';
import { AnnotationsPanel } from './annotations-panel';
import { AttachPdf } from './attach-pdf';
import s from './document-view.module.css';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  type MarkdownSelection,
  MarkdownView,
  type MarkdownViewHandle,
} from './markdown-view';
import { type PdfSelection, PdfViewer, type PdfViewerHandle } from './pdf-viewer';
import { ReaderChrome } from './reader-chrome';

const PANEL_KEY = 'quire.annotations.open';
const FONT_KEY = 'quire.reader.fontScale';
const STATUSES = ['unread', 'reading', 'done'] as const;

export function DocumentView({
  slug,
  document: doc,
  annotations: initial,
  html,
  canAnnotate = true,
  lite = false,
  platform = 'desktop',
}: {
  slug: string;
  document: Document;
  annotations: Annotation[];
  html: string;
  /** Text-selection annotations (feature documents.annotate). */
  canAnnotate?: boolean;
  /** Memory-safe rendering and a simplified panel (feature documents.viewer = lite). */
  lite?: boolean;
  platform?: 'phone' | 'tablet' | 'desktop';
}) {
  const phone = platform === 'phone';
  const router = useRouter();
  const [pending, start] = useTransition();
  const viewer = useRef<PdfViewerHandle>(null);
  const mdView = useRef<MarkdownViewHandle>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef({ page: doc.lastPage, progress: doc.progress });
  // Server-known default (tablets start collapsed); the stored preference is applied after mount so SSR and
  // hydration agree.
  const [collapsed, setCollapsed] = useState(platform === 'tablet');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PANEL_KEY);
      if (stored === '0') setCollapsed(true);
      if (stored === '1') setCollapsed(false);
    } catch {}
  }, []);
  const [selection, setSelection] = useState<PdfSelection | MarkdownSelection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [annotations, mutate] = useOptimistic(
    initial,
    (
      state: Annotation[],
      change:
        | { op: 'add'; row: Annotation }
        | { op: 'patch'; id: string; patch: Partial<Annotation> }
        | { op: 'del'; id: string },
    ) => {
      if (change.op === 'add') return [...state, change.row];
      if (change.op === 'patch')
        return state.map((x) => (x.id === change.id ? { ...x, ...change.patch } : x));
      return state.filter((x) => x.id !== change.id);
    },
  );

  // Phone reader state: chrome visibility, sheets, position, text size.
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<'annotations' | 'more' | null>(null);
  const [pos, setPos] = useState({ page: doc.lastPage, count: doc.pageCount ?? 0 });
  const [fraction, setFraction] = useState(0);
  const [fontScale, setFontScaleState] = useState(1);
  useEffect(() => {
    if (!phone) return;
    try {
      const v = Number(window.localStorage.getItem(FONT_KEY));
      if (v >= FONT_SCALE_MIN && v <= FONT_SCALE_MAX) setFontScaleState(v);
    } catch {}
    // Show the bar briefly on open so the reader learns where it lives, then get out of the way.
    const t = setTimeout(() => setChrome(false), 2500);
    return () => clearTimeout(t);
  }, [phone]);
  const setFontScale = useCallback((next: number) => {
    const v = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(next * 20) / 20));
    setFontScaleState(v);
    try {
      window.localStorage.setItem(FONT_KEY, String(v));
    } catch {}
  }, []);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  // The popover sits outside the scroller in visible-area coordinates, so it goes away when the text scrolls.
  const clearSelection = useCallback(() => setSelection(null), []);
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);
  // Scrolling hides the bar, except while a sheet is up (its own scrolling should not affect the reader bar).
  const hideChrome = useCallback(() => {
    if (!sheetRef.current) setChrome(false);
  }, []);
  // Closing a sheet returns to the bar, the thing the reader is most likely to want next.
  const closeSheet = useCallback(() => {
    setSheet(null);
    setChrome(true);
  }, []);

  const togglePanel = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(PANEL_KEY, c ? '1' : '0');
      } catch {}
      return !c;
    });

  const setStatus = (readingStatus: 'unread' | 'reading' | 'done') =>
    start(async () => {
      await updateDocumentAction(slug, doc.id, { readingStatus });
      router.refresh();
    });

  // Save reading position at most every 1.5s and only when it changed.
  const onProgress = useCallback(
    (page: number, pageCount: number) => {
      setPos({ page, count: pageCount });
      const progress = pageCount > 0 ? Math.max(lastSaved.current.progress, page / pageCount) : 0;
      if (page === lastSaved.current.page && progress === lastSaved.current.progress) return;
      if (progressTimer.current) clearTimeout(progressTimer.current);
      progressTimer.current = setTimeout(() => {
        lastSaved.current = { page, progress };
        const patch: { lastPage: number; progress: number; readingStatus?: 'reading' } = {
          lastPage: page,
          progress,
        };
        if (doc.readingStatus === 'unread' && page > 1) patch.readingStatus = 'reading';
        void updateDocumentAction(slug, doc.id, patch);
      }, 1500);
    },
    [slug, doc.id, doc.readingStatus],
  );

  const addAnnotation = (anchor: Anchor | null) => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setCollapsed(false);
    if (phone) setSheet('annotations');
    start(async () => {
      const row = await createAnnotationAction(slug, { documentId: doc.id, anchor, type: 'note', body: '' });
      setFocusId(row.id);
      setActiveId(row.id);
      router.refresh();
    });
  };

  const changeType = (id: string, type: AnnotationType) =>
    start(async () => {
      mutate({ op: 'patch', id, patch: { type } });
      await updateAnnotationAction(slug, doc.id, id, { type });
      router.refresh();
    });
  const changeBody = (id: string, body: string) =>
    start(async () => {
      mutate({ op: 'patch', id, patch: { body } });
      await updateAnnotationAction(slug, doc.id, id, { body });
      router.refresh();
    });
  const remove = (id: string) =>
    start(async () => {
      mutate({ op: 'del', id });
      await deleteAnnotationAction(slug, doc.id, id);
      router.refresh();
    });
  const scrollToAnnotation = (x: Annotation) => {
    const anchor = x.anchor as Anchor | null;
    if (anchor?.kind === 'pdf') viewer.current?.scrollToAnchor(anchor);
    if (anchor?.kind === 'markdown') mdView.current?.scrollToAnchor(anchor);
  };
  const ask = () =>
    window.dispatchEvent(
      new CustomEvent('quire:ask', { detail: { documentId: doc.id, documentTitle: doc.title } }),
    );
  const confirmDelete = () => {
    if (window.confirm(`Delete "${doc.title}"? This cannot be undone.`))
      start(() => deleteDocumentAction(slug, doc.id));
  };

  const pdfHighlights = useMemo(
    () =>
      annotations
        .filter((x) => x.anchor && (x.anchor as Anchor).kind === 'pdf')
        .map((x) => ({ id: x.id, type: x.type, anchor: x.anchor as PdfAnchor })),
    [annotations],
  );
  const mdHighlights = useMemo(
    () =>
      annotations
        .filter((x) => x.anchor && (x.anchor as Anchor).kind === 'markdown')
        .map((x) => ({ id: x.id, type: x.type, anchor: x.anchor as MarkdownAnchor })),
    [annotations],
  );

  const content =
    doc.kind === 'pdf' && doc.filePath ? (
      <PdfViewer
        ref={viewer}
        fileUrl={`/api/projects/${slug}/documents/${doc.id}/file`}
        initialPage={doc.lastPage}
        highlights={pdfHighlights}
        activeHighlightId={activeId}
        onProgress={onProgress}
        onSelection={canAnnotate ? setSelection : undefined}
        maxPixelRatio={phone ? 1.5 : 2}
        maxCanvasPixels={phone ? 6_000_000 : 16_000_000}
        renderWindow={lite ? 1 : 2}
        textLayer={canAnnotate}
        minZoom={phone ? 1 : 0.5}
        maxZoom={phone ? 4 : 3}
        fitPadding={phone ? 8 : 48}
        pinch={phone}
        onTap={phone ? toggleChrome : undefined}
        onScroll={phone ? hideChrome : clearSelection}
      />
    ) : doc.kind === 'markdown' ? (
      <MarkdownView
        ref={mdView}
        html={html}
        highlights={mdHighlights}
        activeHighlightId={activeId}
        onSelection={canAnnotate ? setSelection : undefined}
        onWikiLink={(name) => start(() => followWikiLinkAction(slug, name))}
        fontScale={phone ? fontScale : 1}
        onFontScale={phone ? setFontScale : undefined}
        pinch={phone}
        onTap={phone ? toggleChrome : undefined}
        onScroll={phone ? hideChrome : clearSelection}
        onProgress={phone ? setFraction : undefined}
      />
    ) : (
      <AttachPdf slug={slug} document={doc} />
    );

  if (phone) {
    const position =
      doc.kind === 'pdf' ? `${pos.page} / ${pos.count || '…'}` : `${Math.round(fraction * 100)}%`;
    return (
      <div className={s.wrapImmersive} data-testid="reader">
        <div className={a11y.viewerCol}>{content}</div>
        <ReaderChrome
          slug={slug}
          title={doc.title}
          position={position}
          annotationCount={annotations.length}
          visible={chrome}
          onAnnotations={() => setSheet('annotations')}
          onMore={() => setSheet('more')}
          onTitleTap={() => (doc.kind === 'pdf' ? viewer.current : mdView.current)?.scrollToTop()}
        />
        <BottomSheet
          open={sheet === 'annotations'}
          onClose={closeSheet}
          title={`Annotations · ${annotations.length}`}
          snap="full"
          data-testid="annotations-sheet"
          actions={
            <button
              type="button"
              className={a11y.iconBtn}
              aria-label="Add a general annotation"
              onClick={() => addAnnotation(null)}
            >
              <Icon icon={Plus} />
            </button>
          }
        >
          <AnnotationsList
            annotations={annotations}
            activeId={activeId}
            onHover={setActiveId}
            onScrollTo={(x) => {
              closeSheet();
              setActiveId(x.id);
              scrollToAnnotation(x);
            }}
            onChangeType={changeType}
            onChangeBody={changeBody}
            onDelete={remove}
            focusId={focusId}
            tapToScroll
            emptyHint="No annotations yet. Use + for a general note; text annotations are made on an iPad or laptop."
          />
        </BottomSheet>
        <BottomSheet open={sheet === 'more'} onClose={closeSheet} title={doc.title} data-testid="more-sheet">
          <div className={s.moreBody}>
            <div className={s.moreRow}>
              <span className={s.moreLabel}>Status</span>
              <div className={s.barRight}>
                {STATUSES.map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={s.chip}
                    data-active={doc.readingStatus === st}
                    disabled={pending}
                    onClick={() => setStatus(st)}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
            {doc.kind === 'markdown' && (
              <div className={s.moreRow}>
                <span className={s.moreLabel}>Text size</span>
                <div className={s.barRight}>
                  <button
                    type="button"
                    className={s.chip}
                    aria-label="Smaller text"
                    onClick={() => setFontScale(fontScale - 0.1)}
                  >
                    A−
                  </button>
                  <span className={s.moreValue}>{Math.round(fontScale * 100)}%</span>
                  <button
                    type="button"
                    className={s.chip}
                    aria-label="Larger text"
                    onClick={() => setFontScale(fontScale + 0.1)}
                  >
                    A+
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              className={s.moreAction}
              onClick={() => {
                closeSheet();
                ask();
              }}
            >
              <Icon icon={MessageSquare} /> Ask the AI about this document
            </button>
            <button type="button" className={s.moreAction} data-danger onClick={confirmDelete}>
              <Icon icon={Trash2} /> Delete document
            </button>
          </div>
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <NextLink href={`/p/${slug}/documents`} className={s.back}>
          <Icon icon={ArrowLeft} /> Documents
        </NextLink>
        <span className={s.barTitle}>{doc.title}</span>
        <div className={s.barRight}>
          {doc.kind === 'pdf' && doc.filePath && (
            <span className={s.zoom} role="group" aria-label="Zoom">
              <button
                type="button"
                className={s.chip}
                aria-label="Zoom out"
                onClick={() => viewer.current?.zoomOut()}
              >
                <Icon icon={Minus} />
              </button>
              <button
                type="button"
                className={s.chip}
                aria-label="Fit width"
                onClick={() => viewer.current?.fitWidth()}
              >
                <Icon icon={Scan} />
              </button>
              <button
                type="button"
                className={s.chip}
                aria-label="Zoom in"
                onClick={() => viewer.current?.zoomIn()}
              >
                <Icon icon={Plus} />
              </button>
            </span>
          )}
          {STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              className={s.chip}
              data-active={doc.readingStatus === st}
              disabled={pending}
              onClick={() => setStatus(st)}
            >
              {st}
            </button>
          ))}
          <button
            type="button"
            className={s.chip}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            title="Ask the AI about this document"
            onClick={ask}
          >
            <Icon icon={MessageSquare} /> Ask
          </button>
          {doc.kind === 'markdown' && (
            <NextLink
              href={`/p/${slug}/documents/${doc.id}/edit`}
              className={s.chip}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Icon icon={Pencil} /> Edit
            </NextLink>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon icon={Trash2} />}
            aria-label="Delete document"
            onClick={confirmDelete}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className={a11y.shell}>
        <div className={a11y.viewerCol}>
          {content}
          {selection && canAnnotate && (
            <div
              className={a11y.popover}
              data-below={selection.box.top < 56 ? 'true' : undefined}
              style={{
                top:
                  selection.box.top < 56 ? selection.box.top + selection.box.height + 8 : selection.box.top,
                left: selection.box.left + selection.box.width / 2,
              }}
            >
              <button
                type="button"
                className={a11y.popoverBtn}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addAnnotation(selection.anchor)}
              >
                <Icon icon={MessageSquarePlus} /> Annotate
              </button>
            </div>
          )}
        </div>
        <AnnotationsPanel
          annotations={annotations}
          collapsed={collapsed}
          onToggle={togglePanel}
          activeId={activeId}
          onHover={setActiveId}
          onScrollTo={scrollToAnnotation}
          onAddGeneral={() => addAnnotation(null)}
          onChangeType={changeType}
          onChangeBody={changeBody}
          onDelete={remove}
          focusId={focusId}
        />
      </div>
    </div>
  );
}
