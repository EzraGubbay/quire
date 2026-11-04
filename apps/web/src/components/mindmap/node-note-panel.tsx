'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { updateMindMapNoteAction } from '@/app/actions/mindmap';
import { MarkdownEditor } from '@/components/editor/markdown-editor';
import type { MindMapNode } from '@/db/schema';
import s from './mind-map.module.css';

type Status = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Right-hand drawer for a node's hidden Markdown note. Its own thing — the editor runs with wikilinks OFF so these
 * notes never touch the Quire notes graph. Autosaves 1.2 s after typing stops, and flushes on close / tab close.
 */
export function NodeNotePanel({
  slug,
  node,
  onClose,
  onLabel,
  onNoteSaved,
}: {
  slug: string;
  node: MindMapNode;
  onClose: () => void;
  onLabel: (label: string) => void;
  onNoteSaved: (note: string) => void;
}) {
  const [body, setBody] = useState(node.note);
  const [status, setStatus] = useState<Status>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef(node.note);

  const save = useCallback(
    async (text: string) => {
      setStatus('saving');
      try {
        const res = await updateMindMapNoteAction(slug, node.id, text);
        setStatus(res.error ? 'error' : 'saved');
        if (!res.error) onNoteSaved(text);
      } catch {
        setStatus('error');
      }
    },
    [slug, node.id, onNoteSaved],
  );

  const onChange = (text: string) => {
    setBody(text);
    bodyRef.current = text;
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(text), 1200);
  };

  // Flush the pending edit on unmount (panel close) and on tab close.
  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      if (bodyRef.current !== node.note) void save(bodyRef.current);
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside className={s.panel} data-testid="mindmap-note-panel" aria-label="Node note">
      <div className={s.panelBar}>
        <input
          className={s.panelTitle}
          defaultValue={node.label}
          aria-label="Node label"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== node.label) onLabel(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className={s.panelStatus} data-status={status}>
          {status === 'saving'
            ? 'Saving…'
            : status === 'dirty'
              ? 'Unsaved'
              : status === 'saved'
                ? 'Saved'
                : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={X} />}
          aria-label="Close note"
          onClick={onClose}
        />
      </div>
      <div className={s.panelEditor}>
        <MarkdownEditor
          value={body}
          onChange={onChange}
          wikilinks={false}
          toolbar={false}
          placeholderText="A free-form note for this node. Markdown and $TeX$ work; no wiki links."
          autoFocus
        />
      </div>
    </aside>
  );
}
