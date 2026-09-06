'use client';

import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import s from './wikilink-complete.module.css';

const MAX = 8;

/** A `[[` autocomplete for a plain textarea: tracks the query before the caret and offers matching names.
 *  Wire `onKeyDown` first in the textarea's handler (it returns true when it consumed the key), call `refresh`
 *  on key-up and click so caret moves are noticed, and render `list` next to the textarea. */
export function useWikiLinkComplete({
  textareaRef,
  value,
  targets,
  onChange,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  targets: string[];
  onChange: (next: string) => void;
}) {
  const [match, setMatch] = useState<{ from: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const caretAfter = useRef<number | null>(null);

  // Read straight from the DOM: state can lag a render behind the caret, and a key pressed in that gap
  // must not act on a stale match (Enter would re-apply a completion instead of reaching the textarea).
  const current = () => {
    const ta = textareaRef.current;
    if (!ta) return null;
    const head = ta.value.slice(0, ta.selectionStart);
    const m = head.match(/\[\[([^\]\n]*)$/);
    return m ? { from: head.length - m[0].length, query: m[1] ?? '' } : null;
  };
  const keyOf = (m: { from: number; query: string }) => `${m.from}:${m.query}`;
  const optionsFor = (m: { from: number; query: string } | null) =>
    m ? targets.filter((n) => n.toLowerCase().includes(m.query.toLowerCase())).slice(0, MAX) : [];

  const refresh = () => {
    const next = current();
    setMatch((prev) => (prev?.from === next?.from && prev?.query === next?.query ? prev : next));
  };

  // The value changed (typing, or an applied completion): re-read the caret and restore it after an apply.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` drives the re-read; refresh reads the DOM.
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && caretAfter.current !== null) {
      ta.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
    refresh();
  }, [value]);

  const options = optionsFor(match);
  const open = match !== null && keyOf(match) !== dismissed && options.length > 0;
  const selected = Math.min(index, Math.max(0, options.length - 1));

  const apply = (name: string, m = current()) => {
    const ta = textareaRef.current;
    if (!ta || !m) return;
    const inserted = `[[${name}]]`;
    caretAfter.current = m.from + inserted.length;
    onChange(ta.value.slice(0, m.from) + inserted + ta.value.slice(ta.selectionStart));
    setIndex(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const m = current();
    const opts = optionsFor(m);
    if (!m || keyOf(m) === dismissed || opts.length === 0) return false;
    const at = Math.min(index, opts.length - 1);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (i + 1) % opts.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i - 1 + opts.length) % opts.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const name = opts[at];
      if (name) apply(name, m);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(keyOf(m));
      return true;
    }
    return false;
  };

  const list = open ? (
    <div className={s.list} role="listbox" aria-label="Link to">
      {options.map((n, i) => (
        <button
          key={n}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={s.item}
          data-selected={i === selected}
          // Keep the textarea focused: its blur would commit the edit and unmount this list.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setIndex(i)}
          onClick={() => apply(n)}
        >
          {n}
        </button>
      ))}
    </div>
  ) : null;

  return { open, list, onKeyDown, refresh };
}
