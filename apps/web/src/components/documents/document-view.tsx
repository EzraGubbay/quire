'use client';

import { Button, Icon, PaperHeader, Prose } from '@ezragubbay/folio';
import { ArrowLeft, Trash2 } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { deleteDocumentAction, updateDocumentAction } from '@/app/actions/documents';
import type { Document } from '@/db/schema';
import s from './document-view.module.css';

export function DocumentView({
  slug,
  document: doc,
  pages,
}: {
  slug: string;
  document: Document;
  pages: { pageNo: number; text: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const setStatus = (readingStatus: 'unread' | 'reading' | 'done') =>
    start(async () => {
      await updateDocumentAction(slug, doc.id, { readingStatus });
      router.refresh();
    });
  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <NextLink href={`/p/${slug}/documents`} className={s.back}>
          <Icon icon={ArrowLeft} /> Documents
        </NextLink>
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
          {doc.kind === 'pdf' && doc.filePath && (
            <a
              className={s.chip}
              href={`/api/projects/${slug}/documents/${doc.id}/file`}
              target="_blank"
              rel="noreferrer"
            >
              Open PDF
            </a>
          )}
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
                  {p.text.split(/\n{2,}|\n(?=[A-Z0-9])/).map((para, i) => (
                    <p key={`${p.pageNo}-${i}`}>{para}</p>
                  ))}
                </section>
              ))}
            </div>
          )}
        </Prose>
      </div>
    </div>
  );
}
