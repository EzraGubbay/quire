'use client';

import { Button, PaperHeader, Prose } from '@ezragubbay/folio';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef } from 'react';
import { type ActionState, attachPdfAction } from '@/app/actions/documents';
import type { Document } from '@/db/schema';
import s from './document-view.module.css';

/** A paper record without a file yet: show what we know and take a PDF upload. */
export function AttachPdf({ slug, document: doc }: { slug: string; document: Document }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(attachPdfAction, {});
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
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
        <form action={action} className={s.attach}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="documentId" value={doc.id} />
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
          <input
            ref={inputRef}
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            required
            aria-label="PDF file"
            onChange={() => inputRef.current?.form?.requestSubmit()}
          />
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {pending ? 'Uploading and reading…' : 'Attach PDF'}
          </Button>
          {state.error && <p role="alert">{state.error}</p>}
        </form>
      </Prose>
    </div>
  );
}
