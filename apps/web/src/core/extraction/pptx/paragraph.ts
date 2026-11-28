import { child, children, type XNode } from './xml';

/** Stands in for an equation until the OMML linearizer replaces `mathText`. */
export const MATH_PLACEHOLDER = '[math]';

/** Markup-compatibility namespace prefixes this reader understands; a Choice that needs anything else is skipped. */
export const KNOWN_MC: ReadonlySet<string> = new Set(['a14', 'p14', 'p15', 'a15', 'a16', 'p16']);

/** Children of the branch to use: first mc:Choice whose every Requires prefix is known, else mc:Fallback, else []. */
export function mcBranch(alt: XNode): XNode[] {
  for (const c of alt.children) {
    if (c.name !== 'mc:Choice') continue;
    const needs = (c.attrs.Requires ?? '').split(/\s+/).filter(Boolean);
    if (needs.length > 0 && needs.every((p) => KNOWN_MC.has(p))) return c.children;
  }
  return child(alt, 'mc:Fallback')?.children ?? [];
}

export function mathText(_node: XNode, onMath: () => void): string {
  onMath();
  return MATH_PLACEHOLDER;
}

/** Every text node of every a:t child, so CDATA sections and entity splits are not lost. */
const tText = (n: XNode): string =>
  children(n, 'a:t')
    .flatMap((t) => t.children)
    .map((c) => (c.name === '#text' ? (c.text ?? '') : ''))
    .join('');

function runs(nodes: XNode[], onMath: () => void): string {
  let out = '';
  for (const n of nodes) {
    switch (n.name) {
      case 'a:r':
        out += tText(n);
        break;
      case 'a:br':
        out += '\n';
        break;
      case 'a:fld':
        if ((n.attrs.type ?? '').toLowerCase() !== 'slidenum') out += tText(n);
        break;
      case 'a14:m':
      case 'm:oMathPara':
      case 'm:oMath':
        out += mathText(n, onMath);
        break;
      case 'mc:AlternateContent':
        out += runs(mcBranch(n), onMath);
        break;
    }
  }
  return out;
}

/**
 * Normalises line breaks, drops bidi controls, the BOM and C0 controls (keeping tab and newline, and the
 * joiners ZWJ/ZWNJ), trims line ends but keeps leading spaces (code indentation). Whitespace-only -> ''.
 */
export function cleanText(s: string): string {
  const t = s
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the vertical tab is PowerPoint's soft line break.
    .replace(/\u000B/g, '\n')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is exactly the point.
    .replace(/[\u0000-\u0008\u000C-\u001F\u007F]/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  return t.trim() === '' ? '' : t;
}

/**
 * One a:p as text. Runs are concatenated as-is in XML (logical) order: no separators, nothing reordered, and
 * no direction marks added, so Hebrew and English runs keep the order they were typed in.
 */
export function paragraphText(p: XNode, onMath: () => void): string {
  return cleanText(runs(p.children, onMath));
}

/** Paragraph direction: explicit a:pPr@rtl, else the first letter's script. */
export function isRtl(p: XNode, text: string): boolean {
  const rtl = child(p, 'a:pPr')?.attrs.rtl;
  if (rtl === '1' || rtl === 'true') return true;
  if (rtl === '0' || rtl === 'false') return false;
  const letter = /\p{L}/u.exec(text)?.[0];
  return letter !== undefined && /[\p{Script=Hebrew}\p{Script=Arabic}]/u.test(letter);
}

const on = (v: string | undefined): boolean => v === '1' || v === 'true';

/** a:tbl -> 'a | b | c' rows. Merge continuation cells are skipped, empty rows dropped, cells in logical order. */
export function tableText(tbl: XNode, onMath: () => void): string {
  const rows: string[] = [];
  for (const tr of children(tbl, 'a:tr')) {
    const cells: string[] = [];
    for (const tc of children(tr, 'a:tc')) {
      if (on(tc.attrs.hMerge) || on(tc.attrs.vMerge)) continue;
      const body = child(tc, 'a:txBody');
      const parts = body ? children(body, 'a:p').map((p) => paragraphText(p, onMath)) : [];
      cells.push(
        parts
          .filter(Boolean)
          .join(' ')
          .replace(/\s*\n\s*/g, ' ')
          .trim(),
      );
    }
    if (cells.some(Boolean)) rows.push(cells.join(' | '));
  }
  return rows.join('\n');
}
