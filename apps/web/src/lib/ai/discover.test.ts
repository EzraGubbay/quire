import { type Candidate, mergeCandidates, searchArxiv } from './discover';

const c = (over: Partial<Candidate>): Candidate => ({
  id: 'x',
  title: 'T',
  authors: [],
  year: 2020,
  abstract: '',
  url: 'u',
  origin: 'arxiv',
  ...over,
});

describe('discover', () => {
  it('merges the same paper from two indexes and keeps citation counts', () => {
    const out = mergeCandidates([
      [c({ id: 'arxiv:1', title: 'Sparse Attention', arxivId: '1' })],
      [
        c({ id: 's2:a', title: 'Sparse attention.', arxivId: '1', citations: 42, origin: 'semanticscholar' }),
        c({ id: 's2:b', title: 'Other', origin: 'semanticscholar' }),
      ],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.citations).toBe(42);
  });
  it('parses arXiv search results', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2404.02258v1</id><title>Mixture-of-Depths</title><summary>Compute allocation.</summary><published>2024-04-02T00:00:00Z</published><author><name>D. Raposo</name></author></entry></feed>`;
    const out = await searchArxiv('depth', (async () => new Response(xml, { status: 200 })) as typeof fetch);
    expect(out[0]).toMatchObject({ arxivId: '2404.02258', title: 'Mixture-of-Depths', year: 2024 });
  });
});
