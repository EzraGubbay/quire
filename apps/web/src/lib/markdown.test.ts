import { extractWikiLinks, normalizeMathDelimiters, renderMarkdown, wikiSegments } from './markdown';

describe('renderMarkdown', () => {
  it('turns wiki links into anchors and keeps math for MathJax', async () => {
    const html = await renderMarkdown('See [[ELBO tightness|the lemma]] and $\\E[x]$.\n\n$$\n\\int f\n$$');
    expect(html).toContain('data-wikilink="ELBO tightness"');
    expect(html).toContain('>the lemma</a>');
    expect(html).toContain('class="math math-inline">\\(');
    expect(html).toContain('class="math math-display">\\[');
  });
  it('extracts unique link names', () => {
    expect(extractWikiLinks('[[a]] [[b|B]] [[a]]')).toEqual(['a', 'b']);
  });
  it('splits text into runs and links', () => {
    expect(wikiSegments('see [[A|the A]] and [[B]]')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', name: 'A', label: 'the A' },
      { kind: 'text', value: ' and ' },
      { kind: 'link', name: 'B', label: 'B' },
    ]);
    expect(wikiSegments('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
    expect(wikiSegments('')).toEqual([]);
  });
});

describe('normalizeMathDelimiters', () => {
  it('converts LaTeX delimiters outside code', () => {
    expect(normalizeMathDelimiters('a \\(x^2\\) b\n\\[\\int f\\]\n`\\(keep\\)`')).toBe(
      'a $x^2$ b\n$$\\int f$$\n`\\(keep\\)`',
    );
  });
  it('renders LaTeX-delimited math through MathJax spans', async () => {
    const html = await renderMarkdown('Energy \\(E = mc^2\\).');
    expect(html).toContain('class="math math-inline">\\(E = mc^2\\)');
  });
});

describe('course rendering', () => {
  it('keeps single newlines as line breaks and labels after them', async () => {
    const html = await renderMarkdown(
      'Some text\nSome more text: and then some more\n**Theorem:** It holds.',
    );
    expect(html).toContain('Some text<br>');
    expect(html).toMatch(/<br>\s*<strong class="term-label" data-kind="theorem">Theorem:<\/strong>/);
  });
  it('tags labels at the start of a paragraph and leaves other bold alone', async () => {
    const html = await renderMarkdown('**Definition:** A thing.\n\nThis is **bold** but not a label.');
    expect(html).toContain('<strong class="term-label" data-kind="definition">Definition:</strong>');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('renders callouts and algorithm blocks', async () => {
    const html = await renderMarkdown(
      '> [!theorem] Compactness\n> Every bounded sequence has a limit point.\n\n```algorithm\nfor i in 1..n\n  if a[i] > m then m = a[i]\n```',
    );
    expect(html).toContain('class="callout" data-kind="theorem"');
    expect(html).toContain('callout-title');
    expect(html).toContain('class="algorithm"');
    expect(html).toContain('<span class="kw">for</span>');
  });
  it('tags open-question labels', async () => {
    const html = await renderMarkdown('Notes.\n**Question:** Why is the reduction associative?');
    expect(html).toContain('<strong class="term-label" data-kind="question">Question:</strong>');
  });
  it('renders ==highlights== as <mark>, including around inline formatting', async () => {
    expect(await renderMarkdown('The ==race condition== matters.')).toContain(
      'The <mark>race condition</mark> matters.',
    );
    const html = await renderMarkdown('==**bold** and $x$== then ==two==');
    expect(html).toMatch(
      /<mark><strong>bold<\/strong> and <span class="math math-inline">.*?<\/span><\/mark>/,
    );
    expect(html).toContain('<mark>two</mark>');
  });
  it('leaves comparisons, long runs, unclosed and multi-line markers as text', async () => {
    expect(await renderMarkdown('if a == b and c == d')).not.toContain('<mark>');
    expect(await renderMarkdown('a ==== b')).not.toContain('<mark>');
    const open = await renderMarkdown('==never closed');
    expect(open).not.toContain('<mark>');
    expect(open).toContain('==never closed');
    expect(await renderMarkdown('==first line\nsecond line==')).not.toContain('<mark>');
    expect(await renderMarkdown('`x ==y==`')).not.toContain('<mark>');
  });
});
