'use client';

import { Button, Icon } from '@ezragubbay/folio';
import type { Anchor, AnnotationType, MarkdownAnchor, PdfAnchor } from '@quire/shared';
import {
  ArrowLeft,
  Download,
  FileUp,
  GraduationCap,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Pencil,
  Plus,
  Scan,
  Trash2,
} from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import {
  type ReactNode,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  createAnnotationAction,
  deleteAnnotationAction,
  updateAnnotationAction,
} from '@/app/actions/annotations';
import {
  type ActionState,
  attachPdfAction,
  deleteDocumentAction,
  updateDocumentAction,
} from '@/app/actions/documents';
import { followWikiLinkAction } from '@/app/actions/notes';
import { useProject } from '@/components/project-context';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Segmented } from '@/components/ui/segmented';
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
const PANE_KEY = 'quire.session.pane';
const PANE_WIDTH_KEY = 'quire.session.paneWidth';
const PANE_MIN = 320;
const FONT_KEY = 'quire.reader.fontScale';
const STATUSES = ['unread', 'reading', 'done'] as const;

export interface DocumentAside {
  /** Label on the Note | Annotations toggle. */
  label: string;
  node: ReactNode;
  /** Called with the current page so the aside can cite slides. */
  onPage?: (page: number) => void;
}

export function DocumentView({
  slug,
  document: doc,
  annotations: initial,
  html,
  linkTargets = [],
  canAnnotate = true,
  lite = false,
  platform = 'desktop',
  aside,
  backHref,
  backLabel,
  initialPage,
  practiceExam,
}: {
  slug: string;
  document: Document;
  annotations: Annotation[];
  html: string;
  /** Titles offered after typing `[[` in an annotation. */
  linkTargets?: string[];
  /** Text-selection annotations (feature documents.annotate). */
  canAnnotate?: boolean;
  /** Memory-safe rendering and a simplified panel (feature documents.viewer = lite). */
  lite?: boolean;
  platform?: 'phone' | 'tablet' | 'desktop';
  /** Lecture page: a second right-hand pane (the raw note) toggled against the annotations panel. */
  aside?: DocumentAside;
  backHref?: string;
  backLabel?: string;
  /** Open at this page (slide citations). */
  initialPage?: number;
  /** Practice Exams folder: term and solution picker. */
  practiceExam?: { candidates: { id: string; title: string }[] };
}) {
  const phone = platform === 'phone';
  const router = useRouter();
  const { base } = useProject();
  const [pending, start] = useTransition();
  // Lecture page: which pane the right column shows. The stored choice is applied after mount.
  const [pane, setPane] = useState<'aside' | 'annotations'>('aside');
  useEffect(() => {
    if (!aside) return;
    try {
      const stored = window.localStorage.getItem(PANE_KEY);
      if (stored === 'annotations' || stored === 'aside') setPane(stored);
    } catch {}
  }, [aside]);
  const choosePane = (p: 'aside' | 'annotations') => {
    setPane(p);
    try {
      window.localStorage.setItem(PANE_KEY, p);
    } catch {}
  };
  // The note pane's width is dragged at its left edge and remembered per device.
  const [asideWidth, setAsideWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!aside) return;
    try {
      const v = Number(window.localStorage.getItem(PANE_WIDTH_KEY));
      if (v >= PANE_MIN) setAsideWidth(v);
    } catch {}
  }, [aside]);
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const el = e.currentTarget.parentElement;
    const startWidth = el?.getBoundingClientRect().width ?? asideWidth ?? 520;
    const maxWidth = Math.max(PANE_MIN, window.innerWidth * 0.75);
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = Math.min(maxWidth, Math.max(PANE_MIN, startWidth + (startX - ev.clientX)));
      setAsideWidth(width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem(PANE_WIDTH_KEY, String(Math.round(width)));
      } catch {}
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
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
  const onPage = aside?.onPage;
  const onProgress = useCallback(
    (page: number, pageCount: number) => {
      setPos({ page, count: pageCount });
      onPage?.(page);
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
    [slug, doc.id, doc.readingStatus, onPage],
  );

  const addAnnotation = (anchor: Anchor | null) => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setCollapsed(false);
    if (aside) choosePane('annotations');
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
  const followLink = (name: string) => start(() => followWikiLinkAction(slug, name));
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
        initialPage={initialPage ?? doc.lastPage}
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
        onWikiLink={followLink}
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
            onFollowLink={followLink}
            linkTargets={linkTargets}
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
        <NextLink href={backHref ?? `${base}/documents`} className={s.back}>
          <Icon icon={ArrowLeft} /> {backLabel ?? 'Documents'}
        </NextLink>
        <span className={s.barTitle}>{doc.title}</span>
        <div className={s.barRight}>
          {aside && (
            <Segmented<'aside' | 'annotations'>
              aria-label="Right pane"
              size="sm"
              value={pane}
              options={[
                { value: 'aside', label: aside.label },
                { value: 'annotations', label: `Annotations · ${annotations.length}` },
              ]}
              onChange={choosePane}
            />
          )}
          {doc.originalPath && (
            <a
              href={`/api/projects/${slug}/documents/${doc.id}/original`}
              className={s.chip}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title={`Download ${doc.originalName ?? 'the original deck'} (opens in PowerPoint/Keynote with animations)`}
            >
              <Icon icon={Download} /> .{doc.originalPath.split('.').pop()}
            </a>
          )}
          {doc.kind === 'pdf' && doc.filePath && doc.originalPath && (
            <ReplaceRendering slug={slug} documentId={doc.id} />
          )}
          {practiceExam && <ExamDetails slug={slug} doc={doc} candidates={practiceExam.candidates} />}
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
              href={`${base}/documents/${doc.id}/edit`}
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
        {aside && pane === 'aside' ? (
          <aside
            className={s.asideCol}
            aria-label={aside.label}
            data-testid="document-aside"
            style={asideWidth ? { width: asideWidth } : undefined}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a drag handle on the pane's edge, not a form control */}
            <div
              className={s.resizer}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize the note pane (drag, or arrow keys; double-click to reset)"
              aria-valuemin={PANE_MIN}
              aria-valuenow={Math.round(asideWidth ?? 0) || undefined}
              title="Drag to resize · double-click to reset"
              onPointerDown={startResize}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const el = e.currentTarget.parentElement;
                const cur = el?.getBoundingClientRect().width ?? asideWidth ?? 520;
                const next = Math.max(PANE_MIN, cur + (e.key === 'ArrowLeft' ? 24 : -24));
                setAsideWidth(next);
                try {
                  window.localStorage.setItem(PANE_WIDTH_KEY, String(Math.round(next)));
                } catch {}
              }}
              onDoubleClick={() => {
                setAsideWidth(null);
                try {
                  window.localStorage.removeItem(PANE_WIDTH_KEY);
                } catch {}
              }}
            />
            {aside.node}
          </aside>
        ) : (
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
            onFollowLink={followLink}
            linkTargets={linkTargets}
            focusId={focusId}
          />
        )}
      </div>
    </div>
  );
}

/** Swap the PDF rendering of a deck (e.g. one exported from PowerPoint) while keeping the original file. */
function ReplaceRendering({ slug, documentId }: { slug: string; documentId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(attachPdfAction, {});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} style={{ display: 'contents' }}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="documentId" value={documentId} />
      <input
        ref={input}
        type="file"
        name="file"
        accept="application/pdf,.pdf"
        className={s.replace}
        aria-label="Replace rendering (PDF)"
        onChange={() => input.current?.form?.requestSubmit()}
      />
      <button
        type="button"
        className={s.chip}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        disabled={pending}
        title={state.error ?? 'Replace the PDF rendering with one exported from PowerPoint'}
        onClick={() => input.current?.click()}
      >
        <Icon icon={FileUp} /> {pending ? 'Replacing…' : 'Replace rendering'}
      </button>
    </form>
  );
}

/** Practice Exams folder: the exam's term and which document holds its solutions. */
function ExamDetails({
  slug,
  doc,
  candidates,
}: {
  slug: string;
  doc: Document;
  candidates: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const meta = doc.examMeta ?? {};
  const save = (patch: { term?: string; solutionDocumentId?: string | null }) =>
    start(async () => {
      await updateDocumentAction(slug, doc.id, { examMeta: { ...meta, ...patch } });
      router.refresh();
    });
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={s.chip}
        data-active={open || undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        onClick={() => setOpen((o) => !o)}
        title="Exam details (term, solutions)"
      >
        <Icon icon={GraduationCap} /> {meta.term ? meta.term : 'Exam details'}
      </button>
      {open && (
        <div className={s.popover} data-testid="exam-details">
          <label className={s.popoverField}>
            <span>Term</span>
            <input
              className={s.popoverInput}
              defaultValue={meta.term ?? ''}
              placeholder="2024 A, Moed B"
              onBlur={(e) => e.target.value !== (meta.term ?? '') && save({ term: e.target.value })}
            />
          </label>
          <label className={s.popoverField}>
            <span>Solutions</span>
            <select
              className={s.popoverInput}
              value={meta.solutionDocumentId ?? ''}
              onChange={(e) => save({ solutionDocumentId: e.target.value || null })}
            >
              <option value="">none</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <p className={s.popoverHint}>
            Exams with a solutions document attached calibrate tri-weekly tests; a document chosen as
            solutions does not count as an exam.
          </p>
        </div>
      )}
    </span>
  );
}
