'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { ArrowLeft, Check } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { updateDocumentAction } from '@/app/actions/documents';
import { MarkdownEditor } from '@/components/editor/markdown-editor';
import type { Document } from '@/db/schema';
import { renderMarkdownClient } from '@/lib/markdown-client';
import s from './document-editor.module.css';
import { MarkdownView } from './markdown-view';

export function DocumentEditor({
  slug,
  document: doc,
  linkTargets,
  macros,
}: {
  slug: string;
  document: Document;
  linkTargets: string[];
  macros: string[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.markdownBody ?? '');
  const [html, setHtml] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [pending, start] = useTransition();
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live preview.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      renderMarkdownClient(body).then(setHtml);
    }, 250);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [body]);

  const save = useCallback(() => {
    start(async () => {
      await updateDocumentAction(slug, doc.id, { title: title.trim() || doc.title, markdownBody: body });
      setDirty(false);
      setSavedAt(new Date());
      router.refresh();
    });
  }, [slug, doc.id, doc.title, title, body, router]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <NextLink href={`/p/${slug}/documents/${doc.id}`} className={s.back}>
          <Icon icon={ArrowLeft} /> Done editing
        </NextLink>
        <input
          className={s.title}
          aria-label="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
        <span className={s.status}>
          {pending
            ? 'Saving…'
            : dirty
              ? 'Unsaved changes'
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString()}`
                : 'Saved'}
        </span>
        <Button
          variant="primary"
          size="sm"
          icon={<Icon icon={Check} />}
          disabled={pending || !dirty}
          onClick={save}
        >
          Save
        </Button>
      </div>
      <div className={s.split}>
        <MarkdownEditor
          value={body}
          onChange={(v) => {
            setBody(v);
            setDirty(true);
          }}
          linkTargets={linkTargets}
          macros={macros}
          onSave={save}
          autoFocus
        />
        <div className={s.preview}>
          <MarkdownView html={html} />
        </div>
      </div>
    </div>
  );
}
