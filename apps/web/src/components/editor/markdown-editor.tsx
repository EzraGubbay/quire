'use client';

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { TERM_LABEL, TERM_SHORTCUTS, type TermKind, termMarkdown } from '@/lib/term-labels';
import s from './markdown-editor.module.css';

export interface MarkdownEditorHandle {
  /** Inserts text at the cursor (replacing a selection) and focuses the editor. */
  insertAtCursor: (text: string) => void;
  /** Inserts a term label (`**Theorem:** `) on its own line at the cursor. */
  insertLabel: (kind: TermKind) => void;
  focus: () => void;
}

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Names offered after typing `[[`. */
  linkTargets?: string[];
  /** Macro names (without backslash) offered after typing `\`. */
  macros?: string[];
  onSave?: () => void;
  autoFocus?: boolean;
  /** Definition / Claim / Theorem buttons above the editor (the shortcuts work regardless). */
  toolbar?: boolean;
  ref?: Ref<MarkdownEditorHandle>;
}

/** Puts a term label at the cursor: on the current line when it is blank, otherwise on a new paragraph below. */
function insertLabelIn(view: EditorView, kind: TermKind) {
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const atLineStart = from === line.from;
  const lineBlank = line.text.trim() === '';
  const prefix = lineBlank || atLineStart ? '' : '\n';
  const text = `${prefix}${termMarkdown(kind)}`;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

/** CodeMirror 6 Markdown source editor with wiki-link and TeX macro autocomplete, term labels, and RTL-aware lines. */
export function MarkdownEditor({
  value,
  onChange,
  linkTargets = [],
  macros = [],
  onSave,
  autoFocus,
  toolbar = true,
  ref,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave, linkTargets, macros });
  latest.current = { onChange, onSave, linkTargets, macros };

  useImperativeHandle(
    ref,
    () => ({
      insertAtCursor: (text) => {
        const v = view.current;
        if (!v) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        v.focus();
      },
      insertLabel: (kind) => view.current && insertLabelIn(view.current, kind),
      focus: () => view.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    if (!host.current) return;
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const link = ctx.matchBefore(/\[\[([^\]]*)$/);
      if (link) {
        const q = link.text.slice(2).toLowerCase();
        return {
          from: link.from + 2,
          options: latest.current.linkTargets
            .filter((n) => n.toLowerCase().includes(q))
            .slice(0, 20)
            .map((n) => ({ label: n, type: 'text', apply: `${n}]]` })),
          validFor: /^[^\]]*$/,
        };
      }
      const macro = ctx.matchBefore(/\\([A-Za-z]*)$/);
      if (macro && (macro.text.length > 1 || ctx.explicit)) {
        const q = macro.text.slice(1).toLowerCase();
        const names = [...new Set([...latest.current.macros, ...COMMON_TEX])];
        return {
          from: macro.from + 1,
          options: names
            .filter((n) => n.toLowerCase().startsWith(q))
            .slice(0, 30)
            .map((n) => ({ label: n, type: 'keyword' })),
          validFor: /^[A-Za-z]*$/,
        };
      }
      return null;
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        markdown({ codeLanguages: languages }),
        autocompletion({ override: [complete] }),
        placeholder('Write in Markdown. [[wiki links]] and $TeX$ work.'),
        EditorView.lineWrapping,
        // Hebrew lines read right-to-left while math and code stay left-to-right.
        EditorView.perLineTextDirection.of(true),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              latest.current.onSave?.();
              return true;
            },
          },
          ...TERM_SHORTCUTS.flatMap((t) =>
            t.keys.map((key) => ({
              key,
              run: (v: EditorView) => {
                insertLabelIn(v, t.kind);
                return true;
              },
            })),
          ),
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { fontFamily: 'var(--eg-font-mono)', fontSize: '13.5px', height: '100%' },
          '.cm-content': {
            fontFamily: 'var(--eg-font-mono)',
            padding: '12px 0',
            color: 'var(--eg-text)',
            caretColor: 'var(--eg-text)',
          },
          // CodeMirror draws its own caret (default black), invisible on the dark register.
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--eg-text)' },
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
            {
              background: 'var(--eg-accent-soft)',
            },
          '.cm-gutters': { background: 'var(--eg-surface-2)', color: 'var(--eg-muted)', border: 'none' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { lineHeight: '1.55' },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns its document after mount; `value` is only the initial text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={s.wrap}>
      {toolbar && (
        <div className={s.toolbar} role="toolbar" aria-label="Insert">
          {TERM_SHORTCUTS.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={s.termBtn}
              data-kind={t.kind}
              title={`Insert ${TERM_LABEL[t.kind]} label (${t.display})`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => view.current && insertLabelIn(view.current, t.kind)}
            >
              <span className={s.termDot} aria-hidden="true" />
              {TERM_LABEL[t.kind]}
            </button>
          ))}
        </div>
      )}
      <div ref={host} className={s.host} />
    </div>
  );
}

const COMMON_TEX = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'theta',
  'lambda',
  'mu',
  'sigma',
  'phi',
  'omega',
  'frac',
  'sqrt',
  'sum',
  'prod',
  'int',
  'partial',
  'nabla',
  'infty',
  'cdot',
  'times',
  'leq',
  'geq',
  'neq',
  'approx',
  'sim',
  'mathbb',
  'mathcal',
  'mathbf',
  'mathrm',
  'text',
  'left',
  'right',
  'begin',
  'end',
  'hat',
  'bar',
  'tilde',
  'vec',
  'log',
  'exp',
  'min',
  'max',
  'argmin',
  'argmax',
  'operatorname',
  'mathbb{E}',
  'KL',
];
