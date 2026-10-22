import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { common } from 'lowlight';
import type { BlockContent, Blockquote, Paragraph, PhrasingContent, Root } from 'mdast';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { termKindOf } from './term-labels';

/** `[[Name]]` and `[[Name|label]]` become links with `data-wikilink`; resolution happens on click. */
function remarkWikiLinks() {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      if (!re.test(value)) return;
      re.lastIndex = 0;
      const out: PhrasingContent[] = [];
      let last = 0;
      for (const m of value.matchAll(re)) {
        const at = m.index ?? 0;
        if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
        const name = (m[1] ?? '').trim();
        const label = (m[2] ?? name).trim();
        out.push({
          type: 'link',
          url: `#wiki:${encodeURIComponent(name)}`,
          data: { hProperties: { 'data-wikilink': name, class: 'wikilink' } },
          children: [{ type: 'text', value: label }],
        });
        last = at + m[0].length;
      }
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}

const PHRASING_PARENTS = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link',
]);

/**
 * Obsidian `==highlight==` becomes <mark>. A pair stays within one line, may wrap other inline formatting
 * (`==**bold** and $x$==`), and flanks like emphasis: `==` opens before a non-space and closes after one, so
 * comparisons such as `a == b` stay text. Runs of three or more `=` are left alone. Runs after remark-breaks, so a
 * typed newline is a `break` node that ends any open pair.
 */
function remarkHighlight() {
  const marker = /(?<!=)==(?!=)/g;
  const wrap = (kids: PhrasingContent[]): PhrasingContent[] | null => {
    const out: PhrasingContent[] = [];
    // Index in `out` where the open pair's content starts; the literal `==` placeholder sits just before it and
    // stays as text if the pair never closes.
    let open = -1;
    let changed = false;
    kids.forEach((node, i) => {
      if (node.type !== 'text' || !node.value.includes('==')) {
        if (node.type === 'break') open = -1;
        out.push(node);
        return;
      }
      const v = node.value;
      const next = kids[i + 1];
      let last = 0;
      for (const m of v.matchAll(marker)) {
        const at = m.index ?? 0;
        // A neighbouring inline element (bold, math, link) counts as a non-space character.
        const before = at > 0 ? (v[at - 1] ?? ' ') : i > 0 ? 'x' : ' ';
        const after = at + 2 < v.length ? (v[at + 2] ?? ' ') : next && next.type !== 'break' ? 'x' : ' ';
        if (open < 0 && /\S/.test(after)) {
          if (at > last) out.push({ type: 'text', value: v.slice(last, at) });
          out.push({ type: 'text', value: '==' });
          open = out.length;
          last = at + 2;
        } else if (open >= 0 && /\S/.test(before)) {
          if (at > last) out.push({ type: 'text', value: v.slice(last, at) });
          const inner = out.splice(open);
          out.pop();
          out.push({ type: 'emphasis', data: { hName: 'mark' }, children: inner });
          open = -1;
          changed = true;
          last = at + 2;
        }
      }
      if (last < v.length) out.push({ type: 'text', value: v.slice(last) });
    });
    return changed ? out : null;
  };
  return (tree: Root) => {
    visit(tree, (node) => {
      if (!PHRASING_PARENTS.has(node.type) || !('children' in node)) return;
      const parent = node as { children: PhrasingContent[] };
      const next = wrap(parent.children);
      if (next) parent.children = next;
    });
  };
}

export const CALLOUT_KINDS = [
  'definition',
  'theorem',
  'lemma',
  'claim',
  'proposition',
  'corollary',
  'proof',
  'example',
  'remark',
  'note',
  'warning',
  'tip',
  'question',
] as const;

/**
 * Obsidian-style callouts: a blockquote starting with `[!kind] Title` becomes
 * `<aside class="callout" data-kind="kind"><p class="callout-title">…</p>…</aside>`. `[!proof]-` collapses.
 */
function remarkCallouts() {
  const re = /^\[!([a-z]+)\]([+-])?\s*(.*)$/i;
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0];
      if (!first || first.type !== 'paragraph') return;
      const text = first.children[0];
      if (!text || text.type !== 'text') return;
      const nl = text.value.indexOf('\n');
      const firstLine = nl >= 0 ? text.value.slice(0, nl) : text.value;
      const m = firstLine.match(re);
      if (!m) return;
      const kind = (m[1] ?? '').toLowerCase();
      if (!(CALLOUT_KINDS as readonly string[]).includes(kind)) return;
      const collapsed = m[2] === '-';
      const title = (m[3] ?? '').trim() || kind[0]?.toUpperCase() + kind.slice(1);
      // Drop the marker line from the paragraph; keep the rest of its text (and inline children) as the first body paragraph.
      const rest = nl >= 0 ? text.value.slice(nl + 1) : '';
      const bodyFirst: Paragraph = {
        type: 'paragraph',
        children: [{ type: 'text', value: rest }, ...first.children.slice(1)],
      };
      const hasBody = rest.trim() !== '' || first.children.length > 1;
      const titleNode: Paragraph = {
        type: 'paragraph',
        data: { hProperties: { className: ['callout-title'] } },
        children: [{ type: 'text', value: title }],
      };
      const children: BlockContent[] = [
        titleNode,
        ...(hasBody ? [bodyFirst] : []),
        ...(node.children.slice(1) as BlockContent[]),
      ];
      const n = node as unknown as { data?: Record<string, unknown>; children: BlockContent[] };
      n.data = {
        hName: collapsed ? 'details' : 'aside',
        hProperties: {
          className: ['callout'],
          'data-kind': kind,
          ...(collapsed ? { 'data-collapsible': 'true' } : {}),
        },
      };
      n.children = children;
    });
  };
}

/** remark-math emits `<code class="language-math math-inline">` and `<pre><code class="language-math math-display">`;
 *  turn them into span/div with MathJax delimiters so the browser typesets them. */
function rehypeMathDelimiters() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'code' && classesOf(node).includes('math-inline')) {
        node.tagName = 'span';
        node.properties = { className: ['math', 'math-inline'] };
        node.children = [{ type: 'text', value: '\\(' }, ...node.children, { type: 'text', value: '\\)' }];
        return;
      }
      if (node.tagName === 'pre') {
        const code = node.children[0];
        if (code && code.type === 'element' && classesOf(code).includes('math-display')) {
          node.tagName = 'div';
          node.properties = { className: ['math', 'math-display'] };
          node.children = [{ type: 'text', value: '\\[' }, ...code.children, { type: 'text', value: '\\]' }];
        }
      }
    });
  };
}

const classesOf = (node: Element): string[] => {
  const cls: unknown = node.properties?.className;
  return Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(' ') : [];
};

const textOf = (node: ElementContent): string =>
  node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(textOf).join('') : '';

const ALGO_KEYWORDS =
  /\b(if|then|else|elif|end|for|while|do|repeat|until|return|function|procedure|algorithm|input|output|require|ensure|each|in|to|downto|break|continue|and|or|not|true|false|null|nil|let|new|yield|await|async|switch|case|default|throw|try|catch|finally|parallel|atomic|lock|unlock|barrier|spawn|sync)\b/g;

/**
 * ```algorithm blocks render like LaTeX algorithmic: a <div> (so MathJax typesets `$…$` inside) with numbered lines
 * and keywords wrapped in <span class="kw">. ```mermaid blocks become <pre class="mermaid"> for the client renderer.
 * The callout's <details> gets a <summary> from its title.
 */
function rehypeBlocks() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName === 'details' && classesOf(node).includes('callout')) {
        const title = node.children.find(
          (c) => c.type === 'element' && classesOf(c).includes('callout-title'),
        );
        if (title && title.type === 'element') {
          title.tagName = 'summary';
        }
        return;
      }
      if (node.tagName !== 'pre' || !parent || index === undefined) return;
      const code = node.children[0];
      if (!code || code.type !== 'element' || code.tagName !== 'code') return;
      const classes = classesOf(code);
      if (classes.includes('language-mermaid')) {
        node.properties = { className: ['mermaid'] };
        node.children = [{ type: 'text', value: textOf(code) }];
        return;
      }
      if (
        classes.includes('language-algorithm') ||
        classes.includes('language-pseudo') ||
        classes.includes('language-pseudocode')
      ) {
        const lines = textOf(code).replace(/\n$/, '').split('\n');
        const items: Element[] = lines.map((line) => {
          const indent = line.match(/^\s*/)?.[0].length ?? 0;
          const body = line.trimStart();
          const parts: ElementContent[] = [];
          let last = 0;
          for (const m of body.matchAll(ALGO_KEYWORDS)) {
            const at = m.index ?? 0;
            if (at > last) parts.push({ type: 'text', value: body.slice(last, at) });
            parts.push({
              type: 'element',
              tagName: 'span',
              properties: { className: ['kw'] },
              children: [{ type: 'text', value: m[0] }],
            });
            last = at + m[0].length;
          }
          if (last < body.length) parts.push({ type: 'text', value: body.slice(last) });
          return {
            type: 'element',
            tagName: 'li',
            properties: { style: `--indent:${Math.floor(indent / 2)}` },
            children: parts.length ? parts : [{ type: 'text', value: ' ' }],
          };
        });
        const replacement: Element = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['algorithm'] },
          children: [{ type: 'element', tagName: 'ol', properties: {}, children: items }],
        };
        parent.children.splice(index, 1, replacement);
      }
    });
  };
}

/**
 * Bold labels like `**Theorem:**` at the start of a paragraph, list item or cell, or right after a line break,
 * get a kind for the tinted highlight.
 */
function rehypeTermLabels() {
  const tag = (el: Element) => {
    const kind = termKindOf(textOf(el));
    if (!kind) return;
    el.properties = { ...el.properties, className: [...classesOf(el), 'term-label'], 'data-kind': kind };
  };
  return (tree: HastRoot) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'p' && node.tagName !== 'li' && node.tagName !== 'td') return;
      let lineStart = true;
      for (const c of node.children) {
        if (c.type === 'text') {
          if (c.value.trim() !== '') lineStart = false;
          continue;
        }
        if (c.type !== 'element') continue;
        if (c.tagName === 'br') {
          lineStart = true;
          continue;
        }
        if (lineStart && c.tagName === 'strong') tag(c);
        lineStart = false;
      }
    });
  };
}

/** Hebrew paragraphs read right-to-left; `dir="auto"` lets the browser decide per block while math stays LTR. */
function rehypeDirAuto() {
  const tags = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'blockquote', 'summary']);
  return (tree: HastRoot) => {
    visit(tree, 'element', (node) => {
      if (tags.has(node.tagName) && node.properties?.dir === undefined)
        node.properties = { ...node.properties, dir: 'auto' };
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkCallouts)
  .use(remarkWikiLinks)
  // A typed newline is a rendered newline (no two-space or blank-line dance), as in Obsidian's default.
  .use(remarkBreaks)
  .use(remarkHighlight)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeMathDelimiters)
  .use(rehypeBlocks)
  .use(rehypeHighlight, {
    languages: common,
    aliases: { cpp: ['cuda', 'cu'], plaintext: ['text', 'txt'] },
    detect: false,
    // Math, algorithm and mermaid blocks are rewritten before this runs; everything else with a language tag is highlighted.
  })
  .use(rehypeTermLabels)
  .use(rehypeDirAuto)
  .use(rehypeStringify);

/** LaTeX-style delimiters `\\[…\\]` and `\\(…\\)` become `$$…$$` and `$…$`; Markdown would otherwise eat the backslashes. */
export function normalizeMathDelimiters(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, t) => `$$${t}$$`)
            .replace(/\\\(([\s\S]*?)\\\)/g, (_, t) => `$${t}$`),
    )
    .join('');
}

/** Markdown → HTML. Math stays as TeX inside `.math` spans/divs for MathJax to typeset in the browser. */
export async function renderMarkdown(md: string): Promise<string> {
  const file = await processor.process(normalizeMathDelimiters(md));
  return String(file);
}

/** Wiki-link names mentioned in a Markdown body, deduplicated in order of appearance. */
export function extractWikiLinks(md: string): string[] {
  const seen = new Set<string>();
  for (const m of md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const name = (m[1] ?? '').trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

export type WikiSegment = { kind: 'text'; value: string } | { kind: 'link'; name: string; label: string };

/** Splits plain text into runs of text and `[[Name]]` / `[[Name|label]]` links, for rendering without Markdown. */
export function wikiSegments(text: string): WikiSegment[] {
  const out: WikiSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const at = m.index ?? 0;
    const name = (m[1] ?? '').trim();
    if (!name) continue;
    if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });
    out.push({ kind: 'link', name, label: (m[2] ?? name).trim() });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
