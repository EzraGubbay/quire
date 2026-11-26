// Rebuilds readable page text from positioned pdf.js text items. Pure (no pdf.js import) so it unit-tests on
// hand-built items. pdf.js only orders and spaces text *inside* one item; between items it gives content-stream
// order, which is visual left-to-right for TeX (so Hebrew lines come out run-reversed), logical for Word, and
// has an item boundary at every font change (so joining items with ' ' splits words, digits and math tokens).
// This module joins items by their geometric gap, puts right-to-left lines in logical order (UAX#9-style
// levels at item granularity), and keeps a little math structure (sub/superscripts, stacked inline fractions,
// overlaid combining marks) instead of flattening it.

export interface PdfTextItem {
  /** Item text as pdf.js returns it: logical order inside the item. */
  str: string;
  /** pdf.js `dir === 'rtl'`: the item contains right-to-left characters. */
  rtl: boolean;
  /** Left end of the baseline, PDF user space (y grows upwards). */
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontName: string;
  /** pdf.js `hasEOL`: a line break follows this item. */
  eol: boolean;
}

export interface PageLayout {
  text: string;
  /** How much formula layout the page has (scripts, fractions, limits, big operators, math symbols). */
  mathScore: number;
}

/** A page whose mathScore reaches this is flagged as math-heavy (its formulas are flattened in text). */
export const MATH_HEAVY_SCORE = 20;

/** Gap (in em) from which neighbouring items may be separate words. */
const SPACE_GAP = 0.15;
/** From this gap on they always are; below it, not next to a bracket or before punctuation (italic corrections). */
const SURE_GAP = 0.2;
/** Fragments whose dominant baselines differ by less than this (in em) are one visual line. */
const SAME_LINE = 0.6;
/** An item this much smaller than the line's font, on a shifted baseline, is a sub/superscript. */
const SCRIPT_SIZE = 0.85;
const SUB_SHIFT = -0.08;
const SUP_SHIFT = 0.15;

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const COMBINING_ONLY = /^\p{M}+$/u;
/** A combining mark with nothing before it to combine with, followed by the character it overlays. */
const LEADING_MARK = /(^|\s)(\p{M}+)([^\s\p{M}])/u;
const LEADING_MARKS = new RegExp(LEADING_MARK.source, 'gu');
const CLOSING = /^[)\]}.,;:!?%’”»]/u;
const OPENING = /[([{‘“«]$/u;
const NUMBER_SEPARATOR = /^[.,:/+\-−]$/u;
const BRACKET = /[()[\]{}]/u;
const BIG_OPERATOR = /[∑∏∐∫∬∭∮⋃⋂⨁⨂⋁⋀√]/gu;
/** Relations, quantifiers, arrows… but not plain arithmetic signs, which fill ordinary tables (3×3, −1). */
const MATH_SYMBOL = /(?![×÷±−])[^\p{ASCII}]/gu;
const IS_MATH_SYMBOL = /\p{Sm}/u;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };

type Role = 'sub' | 'sup';
type Dir = 'L' | 'R';
type Cls = Dir | 'EN' | 'N';

interface Item extends PdfTextItem {
  right: number;
  /** Attached to the previous item as an under/over limit (∑, ⋃, max). */
  limit?: boolean;
}

interface Line {
  /** Content order. */
  items: Item[];
  fs: number;
  y: number;
  minX: number;
  maxX: number;
}

interface Token {
  text: string;
  /** A word gap precedes the token (in the order the tokens were listed). */
  space: boolean;
  rtl: boolean;
  fonts: string[];
  /** Leftmost and rightmost item of the token. */
  left: Item;
  right: Item;
}

/** One unit of a line for direction resolution. Exported for tests. */
export interface Seq {
  text: string;
  cls: Cls;
  /** L only because its font never carries right-to-left text (it has no letter or digit of its own). */
  cue?: boolean;
  /** Letters in the token, for majority votes. */
  letters?: number;
  /** A word gap touches the token (so it cannot be a separator inside a number). */
  loose?: boolean;
}

/** A stretch of output text; `r` marks text at a right-to-left level (its brackets may need mirroring). */
export interface Piece {
  text: string;
  r: boolean;
}

interface Stats {
  scripts: number;
  stacked: number;
}

interface PageContext {
  /** Fonts that carry right-to-left text somewhere on the page. */
  rtlFonts: Set<string>;
  /** Most letters on the page are right-to-left. */
  rtlDominant: boolean;
  /** Right-to-left lines are written left-to-right in the content stream (TeX) rather than logically (Word). */
  visualOrder: boolean;
  /** Right edge of the right-to-left text block. */
  rightMargin: number;
}

const codePoints = (s: string): string[] => Array.from(s);

const NUMBER = /^\p{Nd}+(?:[.,:/]\p{Nd}+)*/u;
/** A dash pdf.js's bidi mistakes for a left-to-right letter: outside Latin-1 and the Hebrew/Arabic blocks. */
const isWideDash = (c: string): boolean => {
  const code = c.codePointAt(0) ?? 0;
  return code > 0xff && !(code >= 0x0590 && code <= 0x08ff) && /\p{Pd}/u.test(c);
};

/**
 * pdf.js's bidi types every character outside Latin-1 and the Hebrew/Arabic blocks as a strong left-to-right
 * letter — the en dash included. Inside a right-to-left item a dash therefore glues itself and the number
 * painted next to it into a "left-to-right run" that is left in visual order: "תרגיל – 2" for "תרגיל 2 –",
 * "7–5" for "5–7". Put such runs (dashes, numbers and the spaces between them, no letters) back in logical
 * order. Exported for tests.
 */
export function fixDashRuns(str: string): string {
  const chars = codePoints(str);
  if (!chars.some(isWideDash)) return str;
  let out = '';
  for (let i = 0; i < chars.length; ) {
    const tokens: string[] = [];
    let j = i;
    let end = i;
    let endTokens = 0;
    let dashes = 0;
    let numbersAfterDash = 0;
    while (j < chars.length) {
      const c = chars[j] as string;
      const number = NUMBER.exec(chars.slice(j).join(''))?.[0];
      if (number) {
        // A second number after the same dash belongs to the next run ("– 2020 2021" is "2020 – 2021").
        if (dashes > 0 && numbersAfterDash > 0) break;
        if (dashes > 0) numbersAfterDash++;
        tokens.push(number);
        j += codePoints(number).length;
      } else if (isWideDash(c)) {
        dashes++;
        numbersAfterDash = 0;
        tokens.push(c);
        j++;
      } else if (/\s/u.test(c) && dashes > 0) {
        tokens.push(c);
        j++;
        continue;
      } else {
        break;
      }
      end = j;
      endTokens = tokens.length;
    }
    if (dashes > 0 && endTokens > 1) {
      out += tokens.slice(0, endTokens).reverse().join('');
      i = end;
    } else {
      out += chars[i];
      i++;
    }
  }
  return out;
}

function dominant(items: Item[]): { fs: number; y: number } {
  const widest = (key: (it: Item) => number, pool: Item[]): number => {
    const sums = new Map<number, number>();
    let best = 0;
    let bestSum = -1;
    for (const it of pool) {
      const k = key(it);
      const sum = (sums.get(k) ?? 0) + it.width + 0.01;
      sums.set(k, sum);
      if (sum > bestSum) {
        best = k;
        bestSum = sum;
      }
    }
    return best;
  };
  const size = (it: Item) => Math.round(it.fontSize * 10) / 10;
  const fs = widest(size, items);
  return {
    fs,
    y: widest(
      (it) => Math.round(it.y * 2) / 2,
      items.filter((it) => size(it) === fs),
    ),
  };
}

function lineOf(items: Item[]): Line {
  const { fs, y } = dominant(items);
  return {
    items,
    fs,
    y,
    minX: Math.min(...items.map((it) => it.x)),
    maxX: Math.max(...items.map((it) => it.right)),
  };
}

/**
 * Visual lines in content order. pdf.js ends a line whenever the pen moves back or far up/down, which splits
 * one visual line at a stacked delimiter, an inline fraction or a limit under ∑; those pieces are put back.
 * Content order stays the backbone, so multi-column reading order is whatever the PDF had.
 */
function buildLines(items: PdfTextItem[]): Line[] {
  const fragments: Item[][] = [];
  let open: Item[] = [];
  for (const raw of items) {
    if (raw.str.trim() !== '') {
      open.push({ ...raw, str: raw.rtl ? fixDashRuns(raw.str) : raw.str, right: raw.x + raw.width });
    }
    if (raw.eol && open.length > 0) {
      fragments.push(open);
      open = [];
    }
  }
  if (open.length > 0) fragments.push(open);

  const lines: Line[] = [];
  let cur: Line | undefined;
  for (const frag of fragments) {
    const next = lineOf(frag);
    if (cur) {
      const line: Line = cur;
      const em = Math.max(line.fs, next.fs);
      const overlap = Math.min(line.maxX, next.maxX) - Math.max(line.minX, next.minX);
      if (Math.abs(line.y - next.y) <= SAME_LINE * em && overlap <= em) {
        cur = lineOf([...line.items, ...frag]);
        continue;
      }
      const last = line.items[line.items.length - 1] as Item;
      const isLimit =
        frag.every((it) => it.fontSize <= SCRIPT_SIZE * line.fs) &&
        codePoints(last.str.trim()).length <= 4 &&
        next.minX >= last.x - line.fs &&
        next.maxX <= last.right + line.fs &&
        Math.abs(next.y - line.y) <= 2 * line.fs;
      if (isLimit) {
        cur = {
          ...line,
          items: [...line.items, ...frag.map((it) => ({ ...it, limit: true }))],
          minX: Math.min(line.minX, next.minX),
          maxX: Math.max(line.maxX, next.maxX),
        };
        continue;
      }
      lines.push(line);
    }
    cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Is there a word gap between two items that are neighbours on a line? */
function gapIsSpace(a: Item, b: Item): boolean {
  const [l, r] = b.x >= a.x ? [a, b] : [b, a];
  const gap = r.x - l.right;
  const em = Math.max(a.fontSize, b.fontSize);
  if (gap >= SURE_GAP * em) return true;
  if (gap < SPACE_GAP * em) return false;
  if (l.rtl || r.rtl) return true;
  return !CLOSING.test(r.str.trimStart()) && !OPENING.test(l.str.trimEnd());
}

/**
 * Drop the second piece of a stacked delimiter (TeX builds a tall `|` from two glyphs at the same x) and put
 * an overlaid combining mark (TeX's `\not` is a zero-width U+0338 *before* the `=`) after the character it
 * covers, so the pair composes to one character (≠).
 */
function tidyItems(items: Item[]): Item[] {
  const out: Item[] = [];
  let pending = '';
  for (const it of items) {
    const prev = out[out.length - 1];
    if (COMBINING_ONLY.test(it.str.trim())) {
      pending += it.str.trim();
      continue;
    }
    if (prev && prev.str === it.str && Math.abs(prev.x - it.x) < 0.5 && Math.abs(prev.y - it.y) > 0.5) {
      continue;
    }
    if (pending) {
      const [first = '', ...rest] = codePoints(it.str);
      out.push({ ...it, str: `${first}${pending}${rest.join('')}`.normalize('NFC') });
      pending = '';
    } else if (LEADING_MARK.test(it.str)) {
      // The same overlay when pdf.js merged the mark and its base into one item ("̸=").
      out.push({ ...it, str: it.str.replace(LEADING_MARKS, '$1$3$2').normalize('NFC') });
    } else {
      out.push(it);
    }
  }
  if (pending && out.length > 0) {
    const last = out[out.length - 1] as Item;
    out[out.length - 1] = { ...last, str: `${last.str}${pending}`.normalize('NFC') };
  }
  return out;
}

function roleOf(it: Item, line: Line): Role | undefined {
  const shift = (it.y - line.y) / line.fs;
  if (it.limit) return shift < 0 ? 'sub' : 'sup';
  if (it.fontSize > SCRIPT_SIZE * line.fs) return undefined;
  if (shift <= SUB_SHIFT) return 'sub';
  if (shift >= SUP_SHIFT) return 'sup';
  return undefined;
}

interface Group {
  role?: Role;
  items: Item[];
  space: boolean;
}

const groupText = (g: Group): string =>
  g.items.map((it, i) => (i > 0 && gapIsSpace(g.items[i - 1] as Item, it) ? ' ' : '') + it.str).join('');

const extent = (g: Group): [number, number] => [
  Math.min(...g.items.map((it) => it.x)),
  Math.max(...g.items.map((it) => it.right)),
];

/** Two script groups sit on top of each other (numerator over denominator). */
function stacked(a: Group, b: Group): boolean {
  const [a0, a1] = extent(a);
  const [b0, b1] = extent(b);
  const overlap = Math.min(a1, b1) - Math.max(a0, b0);
  return overlap > 0 && overlap >= 0.5 * Math.min(a1 - a0, b1 - b0);
}

const fractionPart = (s: string): string => (/^[\p{L}\p{N}]+$/u.test(s) ? s : `(${s})`);

/** Items (in the order given) as tokens: plain items, `_x` / `^{…}` scripts and `a/b` stacked fractions. */
function tokenize(ordered: Item[], line: Line, stats: Stats): Token[] {
  const groups: Group[] = [];
  ordered.forEach((it, i) => {
    const role = roleOf(it, line);
    const last = groups[groups.length - 1];
    if (role && last && last.role === role) last.items.push(it);
    else groups.push({ role, items: [it], space: i > 0 && gapIsSpace(ordered[i - 1] as Item, it) });
  });

  const tokens: Token[] = [];
  const push = (text: string, space: boolean, gs: Group[]) => {
    const items = gs.flatMap((g) => g.items);
    tokens.push({
      text,
      space,
      rtl: items.some((it) => it.rtl),
      fonts: items.map((it) => it.fontName),
      left: items.reduce((a, b) => (b.x < a.x ? b : a)),
      right: items.reduce((a, b) => (b.right > a.right ? b : a)),
    });
  };
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] as Group;
    if (!g.role) {
      push(groupText(g), g.space, [g]);
      continue;
    }
    const next = groups[i + 1];
    // A stacked pair standing on its own (not hugging a base like x_i^2) is an inline fraction.
    if (next?.role && next.role !== g.role && (i === 0 || g.space) && stacked(g, next)) {
      const [num, den] = g.role === 'sup' ? [g, next] : [next, g];
      push(`${fractionPart(groupText(num))}/${fractionPart(groupText(den))}`, g.space, [g, next]);
      stats.stacked++;
      i++;
      continue;
    }
    const body = groupText(g);
    push(`${g.role === 'sub' ? '_' : '^'}${codePoints(body).length === 1 ? body : `{${body}}`}`, false, [g]);
    if (g.items.some((it) => it.limit)) stats.stacked++;
    else stats.scripts++;
  }
  return tokens;
}

/**
 * Embedding levels for a line's tokens (UAX#9 at token granularity): W4 (a separator between two numbers),
 * W7 (a number after left-to-right text continues it), N1/N2 (neutrals take the direction both neighbours
 * agree on — numbers count as R — else the base direction). Mutates the classes of `seq`.
 */
function resolveLevels(seq: Seq[], base: Dir): number[] {
  for (let i = 1; i < seq.length - 1; i++) {
    const t = seq[i] as Seq;
    if (t.cls !== 'N' || t.loose || !NUMBER_SEPARATOR.test(t.text)) continue;
    if (seq[i - 1]?.cls === 'EN' && seq[i + 1]?.cls === 'EN') t.cls = 'EN';
  }
  let strong: Dir = base;
  for (const t of seq) {
    if (t.cls === 'L' || t.cls === 'R') strong = t.cls;
    else if (t.cls === 'EN' && strong === 'L') t.cls = 'L';
  }
  const side = (t: Seq | undefined): Dir => (!t ? base : t.cls === 'L' ? 'L' : 'R');
  for (let i = 0; i < seq.length; ) {
    if ((seq[i] as Seq).cls !== 'N') {
      i++;
      continue;
    }
    let j = i;
    while (j < seq.length && (seq[j] as Seq).cls === 'N') j++;
    const before = side(seq[i - 1]);
    const dir = before === side(seq[j]) ? before : base;
    for (let k = i; k < j; k++) (seq[k] as Seq).cls = dir;
    i = j;
  }
  return seq.map((t) => {
    if (base === 'R') return t.cls === 'R' ? 1 : 2;
    return t.cls === 'L' ? 0 : t.cls === 'EN' ? 2 : 1;
  });
}

/** A neutral item keeps its glyphs in visual order (".)" for logical ")."): reversed at an R level. */
const pieceOf = (t: Seq, level: number, neutral: boolean): Piece => {
  const r = level % 2 === 1;
  return { text: r && neutral ? codePoints(t.text).reverse().join('') : t.text, r };
};

/**
 * Tokens of one line in visual (left-to-right) order → pieces in logical order: resolve the levels, then
 * undo UAX#9's L2 reversals from the lowest level up.
 */
export function visualToLogical(tokens: Seq[], base: Dir): Piece[] {
  const seq = tokens.map((t) => ({ ...t }));
  // A neutral-only tail at the visual right of a right-to-left line that is "L" only by its font (the `}.`
  // closing a TeX display that ends with Hebrew) cannot be where that line starts: keep it at the end.
  const tail: Seq[] = [];
  if (base === 'R') {
    let end = seq.length;
    while (end > 0 && ((seq[end - 1] as Seq).cue || (seq[end - 1] as Seq).text === ' ')) end--;
    const before = seq[end - 1];
    if (end < seq.length && before?.cls === 'R') {
      tail.push(...seq.splice(end).filter((t) => t.text !== ' '));
    }
  }
  if (base === 'L') {
    // A right-to-left phrase with left-to-right words inside it (TeX \text{…} in a display) is one embedding.
    const first = seq.findIndex((t) => t.cls === 'R');
    const last = seq.findLastIndex((t) => t.cls === 'R');
    if (last > first) {
      const span = seq.slice(first, last + 1);
      const count = (cls: Cls) => span.reduce((n, t) => n + (t.cls === cls ? (t.letters ?? 0) : 0), 0);
      if (count('R') > count('L')) {
        return [
          ...visualToLogical(seq.slice(0, first), 'L'),
          ...visualToLogical(span, 'R'),
          ...visualToLogical(seq.slice(last + 1), 'L'),
        ];
      }
    }
  }
  const neutral = seq.map((t) => t.cls === 'N');
  const levels = resolveLevels(seq, base);
  const order = seq.map((t, i) => ({ t, lv: levels[i] as number, neutral: neutral[i] as boolean }));
  const top = Math.max(0, ...levels);
  for (let lv = 1; lv <= top; lv++) {
    for (let i = 0; i < order.length; ) {
      if ((order[i] as { lv: number }).lv < lv) {
        i++;
        continue;
      }
      let j = i;
      while (j < order.length && (order[j] as { lv: number }).lv >= lv) j++;
      order.splice(i, j - i, ...order.slice(i, j).reverse());
      i = j;
    }
  }
  return [
    ...order.map((o) => pieceOf(o.t, o.lv, o.neutral)),
    ...tail.map((t) => ({ text: t.text, r: false })),
  ];
}

function classify(t: Token, ctx: PageContext): Seq {
  const letters = codePoints(t.text).filter((c) => LETTER.test(c)).length;
  if (t.rtl) return { text: t.text, cls: 'R', letters };
  if (letters > 0) return { text: t.text, cls: 'L', letters };
  // TeX sets Latin and math in fonts of their own, and math is a hard left-to-right island.
  if (ctx.visualOrder && t.fonts.every((f) => !ctx.rtlFonts.has(f))) {
    return { text: t.text, cls: 'L', cue: !DIGIT.test(t.text), letters };
  }
  return { text: t.text, cls: DIGIT.test(t.text) ? 'EN' : 'N', letters };
}

function baseDirection(seq: Seq[], line: Line, ctx: PageContext): Dir {
  const strong = seq.filter((t) => t.cls === 'L' || t.cls === 'R');
  const left = strong[0]?.cls;
  const right = strong[strong.length - 1]?.cls;
  if (left === 'R' && right === 'R') return 'R';
  if (left === 'L' && right === 'L') {
    // A paragraph line that happens to start and end with Latin/math still runs to the right margin; a
    // centred display formula does not.
    return ctx.rtlDominant && line.maxX >= ctx.rightMargin - 1.5 * line.fs ? 'R' : 'L';
  }
  return ctx.rtlDominant ? 'R' : 'L';
}

/** A right-to-left line whose items the PDF wrote left to right (TeX): sort by x, then visual → logical. */
function layoutVisualLine(items: Item[], line: Line, ctx: PageContext, stats: Stats): Piece[] {
  const visual = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.x - b.it.x || a.i - b.i);
  const tokens = tokenize(
    visual.map((v) => v.it),
    line,
    stats,
  );
  const seq: Seq[] = [];
  for (const t of tokens) {
    if (t.space) seq.push({ text: ' ', cls: 'N' });
    seq.push(classify(t, ctx));
  }
  return visualToLogical(seq, baseDirection(seq, line, ctx));
}

/**
 * A right-to-left line whose items the PDF wrote in logical order (Word): the order is already right, only
 * the word gaps have to be read off the page. The gap that logically follows a token is on its trailing
 * side, or — when leaving a deeper run — on the leading side of the token that follows.
 */
function layoutLogicalLine(items: Item[], line: Line, ctx: PageContext, stats: Stats): Piece[] {
  const tokens = tokenize(items, line, stats);
  const gapLeft = tokens.map(() => false);
  const gapRight = tokens.map(() => false);
  const byX = tokens.map((t, i) => ({ t, i })).sort((a, b) => a.t.left.x - b.t.left.x || a.i - b.i);
  for (let k = 1; k < byX.length; k++) {
    const a = byX[k - 1] as { t: Token; i: number };
    const b = byX[k] as { t: Token; i: number };
    gapRight[a.i] = gapLeft[b.i] = gapIsSpace(a.t.right, b.t.left);
  }
  let ascending = 0;
  for (let i = 1; i < tokens.length; i++) {
    ascending += (tokens[i] as Token).left.x >= (tokens[i - 1] as Token).left.x ? 1 : -1;
  }
  const seq = tokens.map((t, i) => ({ ...classify(t, ctx), loose: gapLeft[i] || gapRight[i] }));
  const neutral = seq.map((t) => t.cls === 'N');
  const levels = resolveLevels(seq, ascending > 0 ? 'L' : 'R');
  const odd = (i: number) => (levels[i] as number) % 2 === 1;
  const pieces: Piece[] = [];
  seq.forEach((t, i) => {
    if (i > 0) {
      const entering = (levels[i - 1] as number) <= (levels[i] as number);
      const space = entering
        ? odd(i - 1)
          ? gapLeft[i - 1]
          : gapRight[i - 1]
        : odd(i)
          ? gapRight[i]
          : gapLeft[i];
      if (space) pieces.push({ text: ' ', r: false });
    }
    pieces.push(pieceOf(t, levels[i] as number, neutral[i] as boolean));
  });
  return pieces;
}

function layoutLine(line: Line, ctx: PageContext, stats: Stats): Piece[] {
  const items = tidyItems(line.items);
  if (!items.some((it) => it.rtl)) {
    // No right-to-left text: content order is reading order.
    const tokens = tokenize(items, line, stats);
    return [{ text: tokens.map((t) => (t.space ? ' ' : '') + t.text).join(''), r: false }];
  }
  return ctx.visualOrder
    ? layoutVisualLine(items, line, ctx, stats)
    : layoutLogicalLine(items, line, ctx, stats);
}

function balanced(pieces: Piece[], mirror: boolean): boolean {
  const stack: string[] = [];
  for (const p of pieces) {
    for (const raw of p.text) {
      if (!BRACKET.test(raw)) continue;
      const c = mirror && p.r ? (MIRROR[raw] as string) : raw;
      if (c === '(' || c === '[' || c === '{') stack.push(c);
      else if (stack.pop() !== MIRROR[c]) return false;
    }
  }
  return stack.length === 0;
}

const render = (pieces: Piece[], mirror: boolean): string =>
  pieces
    .map((p) => (mirror && p.r ? p.text.replace(/[()[\]{}]/g, (c) => MIRROR[c] as string) : p.text))
    .join('');

function pageContext(lines: Line[]): PageContext {
  const rtlFonts = new Set<string>();
  let rtlLetters = 0;
  let otherLetters = 0;
  let ascending = 0;
  let descending = 0;
  let rightMargin = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    for (const it of line.items) {
      if (it.rtl) rtlFonts.add(it.fontName);
      for (const c of it.str) {
        if (RTL_LETTER.test(c)) rtlLetters++;
        else if (LETTER.test(c)) otherLetters++;
      }
    }
    if (!line.items.some((it) => it.rtl)) continue;
    rightMargin = Math.max(rightMargin, line.maxX);
    for (let i = 1; i < line.items.length; i++) {
      if ((line.items[i] as Item).x >= (line.items[i - 1] as Item).x) ascending++;
      else descending++;
    }
  }
  return {
    rtlFonts,
    rtlDominant: rtlLetters > otherLetters,
    visualOrder: ascending >= descending,
    rightMargin,
  };
}

/** Page text in reading order from pdf.js text items (content order, with positions). */
export function layoutPage(items: PdfTextItem[]): PageLayout {
  const lines = buildLines(items);
  const ctx = pageContext(lines);
  const stats: Stats = { scripts: 0, stacked: 0 };
  const laid = lines.map((line) => layoutLine(line, ctx, stats));
  // TeX stores bracket *shapes* (a "(" glyph closes a right-to-left parenthesis); Word stores the logical
  // character. Whichever reading balances more lines wins for the whole page.
  let asIs = 0;
  let mirrored = 0;
  for (const pieces of laid) {
    if (!pieces.some((p) => p.r && BRACKET.test(p.text))) continue;
    const a = balanced(pieces, false);
    const m = balanced(pieces, true);
    if (a && !m) asIs++;
    if (m && !a) mirrored++;
  }
  const text = laid.map((pieces) => render(pieces, mirrored > asIs).trim()).join('\n');
  const symbols = (text.match(MATH_SYMBOL) ?? []).filter((c) => IS_MATH_SYMBOL.test(c)).length;
  const bigOperators = (text.match(BIG_OPERATOR) ?? []).length;
  return { text, mathScore: stats.scripts + symbols + 3 * (stats.stacked + bigOperators) };
}
