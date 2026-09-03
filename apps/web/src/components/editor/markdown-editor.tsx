'use client';

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import s from './markdown-editor.module.css';

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Names offered after typing `[[`. */
  linkTargets?: string[];
  /** Macro names (without backslash) offered after typing `\`. */
  macros?: string[];
  onSave?: () => void;
  autoFocus?: boolean;
}

/** CodeMirror 6 Markdown source editor with wiki-link and TeX macro autocomplete. */
export function MarkdownEditor({
  value,
  onChange,
  linkTargets = [],
  macros = [],
  onSave,
  autoFocus,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave, linkTargets, macros });
  latest.current = { onChange, onSave, linkTargets, macros };

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
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              latest.current.onSave?.();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { fontFamily: 'var(--eg-font-mono)', fontSize: '13.5px', height: '100%' },
          '.cm-content': { fontFamily: 'var(--eg-font-mono)', padding: '12px 0' },
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

  return <div ref={host} className={s.host} />;
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
