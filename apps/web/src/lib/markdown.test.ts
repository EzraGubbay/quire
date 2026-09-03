import { extractWikiLinks, normalizeMathDelimiters, renderMarkdown } from './markdown';

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
