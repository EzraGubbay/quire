'use client';

import { Button, Icon, PaperHeader, Prose } from '@ezragubbay/folio';
import type { AnnotationType, PdfAnchor } from '@quire/shared';
import { ArrowLeft, MessageSquarePlus, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useOptimistic, useRef, useState, useTransition } from 'react';
import {
  createAnnotationAction,
  deleteAnnotationAction,
  updateAnnotationAction,
} from '@/app/actions/annotations';
import { deleteDocumentAction, updateDocumentAction } from '@/app/actions/documents';
import type { Annotation, Document } from '@/db/schema';
import a11y from './annotations.module.css';
import { AnnotationsPanel } from './annotations-panel';
import s from './document-view.module.css';
import { type PdfSelection, PdfViewer, type PdfViewerHandle } from './pdf-viewer';

const PANEL_KEY = 'quire.annotations.open';

export function DocumentView({
  slug,
  document: doc,
  pages,
  annotations: initial,
}: {
  slug: string;
  document: Document;
  pages: { pageNo: number; text: string }[];
  annotations: Annotation[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const viewer = useRef<PdfViewerHandle>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef({ page: doc.lastPage, progress: doc.progress });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(PANEL_KEY) === '0';
    } catch {
      return false;
    }
  });
  const [selection, setSelection] = useState<PdfSelection | null>(null);
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

  const addAnnotation = (anchor: PdfAnchor | null) => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setCollapsed(false);
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

  const highlights = annotations
    .filter((x) => x.anchor && (x.anchor as PdfAnchor).kind === 'pdf')
    .map((x) => ({ id: x.id, type: x.type, anchor: x.anchor as PdfAnchor }));

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <NextLink href={`/p/${slug}/documents`} className={s.back}>
          <Icon icon={ArrowLeft} /> Documents
        </NextLink>
        <span className={s.barTitle}>{doc.title}</span>
        <div className={s.barRight}>
          {(['unread', 'reading', 'done'] as const).map((st) => (
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
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon icon={Trash2} />}
            aria-label="Delete document"
            onClick={() => {
              if (window.confirm(`Delete "${doc.title}"? This cannot be undone.`))
                start(() => deleteDocumentAction(slug, doc.id));
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className={a11y.shell}>
        <div className={a11y.viewerCol}>
          {doc.kind === 'pdf' && doc.filePath ? (
            <PdfViewer
              ref={viewer}
              fileUrl={`/api/projects/${slug}/documents/${doc.id}/file`}
              initialPage={doc.lastPage}
              highlights={highlights}
              activeHighlightId={activeId}
              onProgress={onProgress}
              onSelection={setSelection}
            />
          ) : (
            <div className={s.paper}>
              <Prose>
                <PaperHeader
                  title={doc.title}
                  authors={doc.authors.join(', ') || undefined}
                  meta={[
                    doc.arxivId ? `arXiv:${doc.arxivId}` : null,
                    doc.doi ? `doi:${doc.doi}` : null,
                    doc.year ? String(doc.year) : null,
                  ].filter((m): m is string => Boolean(m))}
                />
                {doc.abstract && <p className={s.abstract}>{doc.abstract}</p>}
                {doc.kind === 'markdown' ? (
                  <pre className={s.md}>{doc.markdownBody}</pre>
                ) : (
                  <div className={s.pages}>
                    {pages.map((p) => (
                      <section key={p.pageNo} className={s.page} id={`page-${p.pageNo}`}>
                        <div className={s.pageNo}>p. {p.pageNo}</div>
                        <p>{p.text}</p>
                      </section>
                    ))}
                  </div>
                )}
              </Prose>
            </div>
          )}
          {selection && (
            <div
              className={a11y.popover}
              style={{ top: selection.box.top, left: selection.box.left + selection.box.width / 2 }}
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
          onScrollTo={(x) => {
            const anchor = x.anchor as PdfAnchor | null;
            if (anchor?.kind === 'pdf') viewer.current?.scrollToAnchor(anchor);
          }}
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
