'use client';

import { Button, Icon } from '@ezragubbay/folio';
import { Check, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { updateMindMapNoteAction } from '@/app/actions/mindmap';
import { MarkdownView } from '@/components/documents/markdown-view';
import { MarkdownEditor } from '@/components/editor/markdown-editor';
import type { MindMapNode } from '@/db/schema';
import { renderMarkdownClient } from '@/lib/markdown-client';
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
  // A node that already has a note opens rendered (the common case — you select a node to read it); an empty one
  // opens straight in the editor so there's somewhere to type. "Edit" toggles between the two.
  const [editing, setEditing] = useState(() => !node.note.trim());
  const [html, setHtml] = useState('');
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

  // Render the note to HTML for the view mode (MathJax typesets it via MarkdownView). Re-runs when the body changes
  // so switching back from the editor shows the latest text.
  useEffect(() => {
    if (editing) return;
    let alive = true;
    void renderMarkdownClient(body).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [editing, body]);

  // Leaving edit mode: flush any pending autosave immediately so the rendered view reflects the saved text.
  const stopEditing = () => {
    if (timer.current) clearTimeout(timer.current);
    if (bodyRef.current !== node.note && status !== 'saving') void save(bodyRef.current);
    setEditing(false);
  };

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
          icon={<Icon icon={editing ? Check : Pencil} />}
          aria-label={editing ? 'Finish editing note' : 'Edit note'}
          onClick={() => (editing ? stopEditing() : setEditing(true))}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon icon={X} />}
          aria-label="Close note"
          onClick={onClose}
        />
      </div>
      {editing ? (
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
      ) : body.trim() ? (
        <div className={s.panelView} data-testid="mindmap-note-rendered">
          <MarkdownView html={html} />
        </div>
      ) : (
        <p className={s.panelEmpty}>No note yet. Select Edit to add one.</p>
      )}
    </aside>
  );
}
