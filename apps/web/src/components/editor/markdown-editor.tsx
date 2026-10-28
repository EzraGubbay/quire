'use client';

import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
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

/**
 * Wraps each selection in `before`/`after` markers (acting on every cursor). With a selection the wrapped text stays
 * selected; with none the markers are inserted and the caret parks between them. `block` puts the content on its own
 * line between the fences — used for display math (`$$\n…\n$$`).
 */
function wrapSelectionIn(view: EditorView, before: string, after: string, block = false) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const inner = state.sliceDoc(range.from, range.to);
      const insert = block ? `${before}\n${inner}\n${after}` : `${before}${inner}${after}`;
      const start = range.from + before.length + (block ? 1 : 0); // just inside the opening marker
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(start, start + inner.length),
      };
    }),
  );
  view.focus();
}

// Live formatting: decorations that make the note's structure legible AS IT IS TYPED. This stays a raw editor — the
// markers (`**`, `*`, `_`, `==`, `#`, bullets) are never hidden — so we only paint over the source: emphasis reads
// bold/italic, ==highlight== gets the same butter tint as the rendered <mark>, headings grow, and list bullets are
// accented. The markers themselves are muted so the content reads at a glance. Styling lives in markdown-editor.module.css.
const DECO = {
  strong: Decoration.mark({ class: 'cm-md-strong' }),
  em: Decoration.mark({ class: 'cm-md-em' }),
  mark: Decoration.mark({ class: 'cm-md-mark' }),
  marker: Decoration.mark({ class: 'cm-md-marker' }),
  listMarker: Decoration.mark({ class: 'cm-md-list-marker' }),
};
// One line decoration per heading level (`#`..`######`), applied at the line start.
const HEADINGS = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `cm-md-heading cm-md-h${n}` }));

// Inline spans with their marker width: content gets the style, the flanking markers are muted. Emphasis uses
// emphasis-like flanking (markers hug non-space) and highlight mirrors the renderer's `==x==` rule so `a == b` stays
// plain. Single-star/underscore italics avoid the `**` of bold and intra-word underscores.
const INLINE: { re: RegExp; deco: Decoration; marker: number }[] = [
  { re: /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, deco: DECO.strong, marker: 2 },
  { re: /(?<!=)==(?!=)(?=\S)[^\n]+?(?<=\S)(?<!=)==(?!=)/g, deco: DECO.mark, marker: 2 },
  { re: /(?<![*\w])\*(?!\s)[^*\n]+?(?<=\S)\*(?![*\w])/g, deco: DECO.em, marker: 1 },
  { re: /(?<![_\w])_(?!\s)[^_\n]+?(?<=\S)_(?![_\w])/g, deco: DECO.em, marker: 1 },
];

/** Collects the live-formatting decorations for one line's raw text (`base` is the line's document offset). */
function decorateLine(base: number, text: string, out: Range<Decoration>[]) {
  const hashes = /^(#{1,6})\s/.exec(text)?.[1];
  if (hashes) {
    const line = HEADINGS[hashes.length - 1];
    if (line) out.push(line.range(base));
    out.push(DECO.marker.range(base, base + hashes.length));
  }
  // A bullet (`-`, `*`, `+`) or ordered (`1.`) marker at the line start, optionally indented.
  const list = /^(\s*)([-*+]|\d{1,9}\.)\s/.exec(text);
  if (list?.[2]) {
    const at = base + (list[1]?.length ?? 0);
    out.push(DECO.listMarker.range(at, at + list[2].length));
  }
  for (const { re, deco, marker } of INLINE) {
    for (const m of text.matchAll(re)) {
      const start = base + (m.index ?? 0);
      const end = start + m[0].length;
      out.push(DECO.marker.range(start, start + marker));
      out.push(deco.range(start + marker, end - marker));
      out.push(DECO.marker.range(end - marker, end));
    }
  }
}

/** Builds the decoration set for the visible ranges only, so long notes stay cheap to style. */
function buildDecorations(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      decorateLine(line.from, line.text, out);
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

// Recompute on edits and when the viewport scrolls (visible-range styling only covers the lines on screen).
const liveFormatting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

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
        liveFormatting,
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
          // Formatting + math shortcuts. `Mod-` is Cmd on macOS, Ctrl elsewhere (CodeMirror). Each wraps the selection,
          // or with no selection drops the markers and parks the caret between them; the `**`/`*`/`==`/`$` markers
          // render through the live-formatting ViewPlugin. These dodge the editor's Alt-based term labels (Alt+t/q/…)
          // and browser Cmd keys. We avoid Cmd-M for math — macOS minimises the window on Cmd-M, an OS shortcut a page
          // can't reliably suppress — and use E for "equation" instead. Final set:
          //   Mod-b  bold **…**      Mod-i  italic *…*      Mod-Shift-h  highlight ==…==
          //   Mod-e  inline math $…$                        Mod-Shift-e  display math $$ … $$ (content on its own line)
          ...(
            [
              ['Mod-b', '**', '**', false],
              ['Mod-i', '*', '*', false],
              ['Mod-Shift-h', '==', '==', false],
              ['Mod-e', '$', '$', false],
              ['Mod-Shift-e', '$$', '$$', true],
            ] as const
          ).map(([key, before, after, block]) => ({
            key,
            run: (v: EditorView) => {
              wrapSelectionIn(v, before, after, block);
              return true;
            },
          })),
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
