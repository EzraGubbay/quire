import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/** `[[Name]]` and `[[Name|label]]` become links with `data-wikilink`; resolution happens on click. */
function remarkWikiLinks() {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  return (tree: import('mdast').Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      if (!re.test(value)) return;
      re.lastIndex = 0;
      const out: import('mdast').PhrasingContent[] = [];
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

/** remark-math emits `<code class="language-math math-inline">` and `<pre><code class="language-math math-display">`;
 *  turn them into span/div with MathJax delimiters so the browser typesets them. */
function rehypeMathDelimiters() {
  const classesOf = (node: import('hast').Element): string[] => {
    const cls: unknown = node.properties?.className;
    return Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(' ') : [];
  };
  return (tree: import('hast').Root) => {
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

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkWikiLinks)
  .use(remarkRehype)
  .use(rehypeMathDelimiters)
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
