/**
 * Term labels: a bold label at the start of a paragraph (`**Theorem:**`) that renders with a tinted highlight.
 * Shared by the editor (buttons, shortcuts) and the Markdown renderer (which tags matching <strong> elements).
 */
export const TERM_KINDS = [
  'definition',
  'claim',
  'theorem',
  'lemma',
  'proof',
  'corollary',
  'example',
  'remark',
] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const TERM_LABEL: Record<TermKind, string> = {
  definition: 'Definition',
  claim: 'Claim',
  theorem: 'Theorem',
  lemma: 'Lemma',
  proof: 'Proof',
  corollary: 'Corollary',
  example: 'Example',
  remark: 'Remark',
};

/** The three with a button and a shortcut; the rest only get the rendering. Ctrl+Alt is free on macOS and in browsers. */
export const TERM_SHORTCUTS: { kind: TermKind; key: string; display: string }[] = [
  { kind: 'definition', key: 'Ctrl-Alt-d', display: '⌃⌥D' },
  { kind: 'claim', key: 'Ctrl-Alt-c', display: '⌃⌥C' },
  { kind: 'theorem', key: 'Ctrl-Alt-t', display: '⌃⌥T' },
];

/** The Markdown inserted for a label, e.g. `**Theorem:** `. */
export const termMarkdown = (kind: TermKind): string => `**${TERM_LABEL[kind]}:** `;

const LABEL_RE = new RegExp(`^(${TERM_KINDS.map((k) => TERM_LABEL[k]).join('|')})\\b[^:]{0,60}:?$`, 'i');

/** The term kind of a bold label's text ("Theorem:", "Theorem 3.1:", "Definition (limit):"), or null. */
export function termKindOf(text: string): TermKind | null {
  const m = text.trim().match(LABEL_RE);
  if (!m?.[1]) return null;
  const word = m[1].toLowerCase();
  return (TERM_KINDS as readonly string[]).includes(word) ? (word as TermKind) : null;
}
