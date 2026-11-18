'use client';

import { Button, PaperHeader, Prose } from '@ezragubbay/folio';
import { useRef } from 'react';
import { useUploads } from '@/components/uploads/upload-provider';
import type { Document } from '@/db/schema';
import s from './document-view.module.css';

/** A paper record without a file yet: show what we know and take a PDF upload. */
export function AttachPdf({ slug, document: doc }: { slug: string; document: Document }) {
  const { enqueue } = useUploads();
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    const body = new FormData();
    body.set('file', file);
    enqueue({
      name: file.name,
      url: `/api/projects/${encodeURIComponent(slug)}/documents/${encodeURIComponent(doc.id)}/pdf`,
      body,
    });
    input.value = '';
  };
  return (
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
        <div className={s.attach}>
          {doc.originalPath ? (
            <p>
              {doc.conversionError ?? 'This deck has no PDF rendering yet.'}{' '}
              <a href={`/api/projects/${slug}/documents/${doc.id}/original`}>Download the original</a>, export
              it to PDF from PowerPoint or Keynote, and add that file as the rendering.
            </p>
          ) : (
            <p>
              No PDF is attached to this paper yet.
              {doc.sourceUrl && (
                <>
                  {' '}
                  Find it at{' '}
                  <a href={doc.sourceUrl} target="_blank" rel="noreferrer">
                    {doc.sourceUrl}
                  </a>{' '}
                  and upload it here.
                </>
              )}
            </p>
          )}
          <input
            ref={inputRef}
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            required
            aria-label="PDF file"
            onChange={submit}
          />
          <Button type="button" variant="primary" onClick={() => inputRef.current?.click()}>
            {doc.originalPath ? 'Add rendering (PDF)' : 'Attach PDF'}
          </Button>
        </div>
      </Prose>
    </div>
  );
}
