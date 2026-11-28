/**
 * Session name parser (v2).
 *
 * Reads a session kind and number out of a file name or session name. The kind
 * word may sit anywhere in the name, and the number must be written directly
 * after it. A week number is never mistaken for the session number. Names with
 * no kind word return null.
 *
 * Pure on purpose: it lives in core, so it imports nothing but a shared type.
 */
import type { SessionKind } from '@quire/shared';

export interface SessionName {
  kind: SessionKind;
  /** Only a number written right after the kind word; never a week number. */
  number?: number;
  /** What is left once the kind word, its number, the extension and a trailing term marker are removed ('' if nothing). */
  title: string;
}

/** Bounds the regex work on adversarial input; a kind word past this is ignored. */
const MAX_NAME = 512;
/** Bidi control marks (common in Hebrew file names) and zero-width spaces/joiners. */
const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
/** A short extension, only when it has a letter, so `Lec.3` keeps its `.3`. */
const EXT = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,5}$/;
/**
 * Trailing term marker (A 2027, 2027A, spring 2027, Hebrew semester), stripped like the legacy parser does.
 * Inherent ambiguity: a real title ending in a letter A or B plus a year (`Part A 2027`) is read as a term.
 */
const TERM =
  /[\s\-–—(]*(?:(?<!\p{L})[AB]\s*\d{4}|\d{4}\s*[AB](?!\p{L})|(?<!\p{L})(?:spring|fall|autumn|winter|summer)\s*\d{4}|סמסטר\s*(?:[אב]['׳]?(?:\s*\d{4})?|\d{4}))\)?\s*$/iu;
/** Separators allowed between a kind word and its number (includes the Hebrew maqaf). */
const SEP = '[\\s\\-–—־:.#]';
/** Optional "no.", "number", or Hebrew "מספר"/"מס'" written before the number. */
const MARKER = "(?:(?:no|num|number)\\.?|מספר|מס['׳]?)";
/** One to three digits bound to the kind word, not followed by a letter, a digit, or a date/decimal tail like `.03` or `/12`. */
const NUMBER = `${SEP}*(?:${MARKER}${SEP}*)?(\\d{1,3})(?![\\p{L}\\p{N}]|[.,/]\\d)`;
/** A whole token: not preceded by a letter or digit, not followed by a letter. */
const word = (alts: string) => `(?<![\\p{L}\\p{N}])(?:${alts})(?!\\p{L})`;

/**
 * Full words count anywhere. Abbreviations count only at the start of the name
 * or when a number is bound to them. A homework exercise is not a recitation.
 */
const PATTERNS = [
  { kind: 'lecture', short: false, words: 'lecture|הרצאה' },
  { kind: 'lecture', short: true, words: 'lect|lec' },
  {
    kind: 'recitation',
    short: false,
    words: 'recitation|tutorial|tirgul|exercise|תרגול|תירגול|תרגיל(?![\\s\\-־]*בית)',
  },
  { kind: 'recitation', short: true, words: 'rec|tut|ex' },
].map(({ kind, short, words }) => ({
  kind: kind as SessionKind,
  short,
  re: new RegExp(`${word(words)}(?:${NUMBER})?`, 'giu'),
}));

interface Hit {
  kind: SessionKind;
  number?: number;
  start: number;
  end: number;
}

function hits(s: string): Hit[] {
  const out: Hit[] = [];
  for (const p of PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      const start = m.index ?? 0;
      const number = m[1] === undefined ? undefined : Number(m[1]);
      if (p.short && number === undefined && start !== 0) continue;
      out.push({ kind: p.kind, number, start, end: start + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const LEAD = /^[\s\-–—־:.#]+/;
const TRAIL = /[\s\-–—־:.#]+$/;

/** Joins the text on both sides of the removed span, keeping a dash from the gap if there was one. */
function join(left: string, right: string): string {
  const l = left.replace(TRAIL, '');
  const r = right.replace(LEAD, '');
  if (!l || !r) return l || r;
  const gap = left.slice(l.length) + right.slice(0, right.length - r.length);
  const dash = gap.match(/[-–—]/);
  return dash ? `${l} ${dash[0]} ${r}` : `${l} ${r}`;
}

export function parseSessionName(name: string): SessionName | null {
  const s = name
    .slice(0, MAX_NAME)
    .replace(BIDI, '')
    .replace(EXT, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TERM, '')
    .trim();
  const found = hits(s);
  // Prefer the first kind word that has a number; otherwise the first kind word.
  const pick = found.find((h) => h.number !== undefined) ?? found[0];
  if (!pick) return null;
  const title = join(s.slice(0, pick.start), s.slice(pick.end))
    .replace(/^[\s\-–—־:.]+|[\s\-–—־:.]+$/g, '')
    .trim();
  return { kind: pick.kind, number: pick.number, title };
}
