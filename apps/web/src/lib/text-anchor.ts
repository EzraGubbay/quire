import type { MarkdownAnchor } from '@quire/shared';

/** Finds a text-quote anchor inside `root`'s rendered text and returns a DOM Range, or null if it no longer exists. */
export function locateQuote(
  root: HTMLElement,
  anchor: Pick<MarkdownAnchor, 'quote' | 'prefix' | 'suffix' | 'start'>,
): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let full = '';
  const starts: number[] = [];
  let n = walker.nextNode();
  while (n) {
    nodes.push(n as Text);
    starts.push(full.length);
    full += n.textContent ?? '';
    n = walker.nextNode();
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  const hay = norm(full);
  const q = norm(anchor.quote);
  if (!q) return null;
  // Prefer the occurrence whose context matches; fall back to the one nearest the recorded offset.
  const candidates: number[] = [];
  let i = hay.indexOf(q);
  while (i >= 0) {
    candidates.push(i);
    i = hay.indexOf(q, i + 1);
  }
  if (candidates.length === 0) return null;
  const score = (at: number) => {
    const pre = hay.slice(Math.max(0, at - anchor.prefix.length), at);
    const suf = hay.slice(at + q.length, at + q.length + anchor.suffix.length);
    let s = 0;
    if (anchor.prefix && pre.endsWith(norm(anchor.prefix).slice(-8))) s += 2;
    if (anchor.suffix && suf.startsWith(norm(anchor.suffix).slice(0, 8))) s += 2;
    return s - Math.abs(at - anchor.start) / 10000;
  };
  const best = candidates.sort((a, b) => score(b) - score(a))[0] ?? 0;
  // Map normalised offsets back to raw offsets (whitespace runs collapse, so walk both strings).
  const rawStart = rawOffset(full, best);
  const rawEnd = rawOffset(full, best + q.length);
  const range = document.createRange();
  const [sn, so] = nodeAt(nodes, starts, rawStart);
  const [en, eo] = nodeAt(nodes, starts, rawEnd);
  if (!sn || !en) return null;
  range.setStart(sn, so);
  range.setEnd(en, eo);
  return range;
}

function rawOffset(full: string, normIndex: number): number {
  let ni = 0;
  let prevSpace = false;
  for (let ri = 0; ri < full.length; ri++) {
    const ch = full[ri] ?? '';
    const isSpace = /\s/.test(ch);
    if (isSpace && prevSpace) continue;
    if (ni === normIndex) return ri;
    ni++;
    prevSpace = isSpace;
  }
  return full.length;
}

function nodeAt(nodes: Text[], starts: number[], offset: number): [Text | undefined, number] {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const start = starts[i] ?? 0;
    if (offset >= start) return [nodes[i], Math.min(offset - start, nodes[i]?.length ?? 0)];
  }
  return [nodes[0], 0];
}

/** Builds a Markdown anchor from the current selection inside `root`. */
export function anchorFromSelection(root: HTMLElement, range: Range): MarkdownAnchor | null {
  const quote = range.toString().replace(/\s+/g, ' ').trim();
  if (!quote) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let full = '';
  let start = -1;
  let n = walker.nextNode();
  while (n) {
    if (n === range.startContainer) start = full.length + range.startOffset;
    full += n.textContent ?? '';
    n = walker.nextNode();
  }
  if (start < 0) return null;
  const end = start + range.toString().length;
  return {
    kind: 'markdown',
    quote,
    prefix: full.slice(Math.max(0, start - 32), start),
    suffix: full.slice(end, end + 32),
    start,
    end,
  };
}
