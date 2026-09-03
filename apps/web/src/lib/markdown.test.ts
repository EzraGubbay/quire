import { extractWikiLinks, renderMarkdown } from './markdown';

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
