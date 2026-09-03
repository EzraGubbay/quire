import { downloadPdf, fetchArxivMeta, parseReference } from './ingest';

describe('parseReference', () => {
  it('recognises arXiv ids and URLs', () => {
    expect(parseReference('2609.01234')).toEqual({ kind: 'arxiv', id: '2609.01234' });
    expect(parseReference('arXiv:2609.01234v2')).toEqual({ kind: 'arxiv', id: '2609.01234' });
    expect(parseReference('https://arxiv.org/abs/1706.03762v7')).toEqual({ kind: 'arxiv', id: '1706.03762' });
    expect(parseReference('https://arxiv.org/pdf/1706.03762.pdf')).toEqual({
      kind: 'arxiv',
      id: '1706.03762',
    });
    expect(parseReference('hep-th/9901001')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
  });
  it('recognises DOIs and direct URLs', () => {
    expect(parseReference('10.1000/xyz123')).toEqual({ kind: 'doi', doi: '10.1000/xyz123' });
    expect(parseReference('https://doi.org/10.1000/xyz123')).toEqual({ kind: 'doi', doi: '10.1000/xyz123' });
    expect(parseReference('doi:10.1000/xyz123')).toEqual({ kind: 'doi', doi: '10.1000/xyz123' });
    expect(parseReference('https://example.org/paper.pdf')).toEqual({
      kind: 'url',
      url: 'https://example.org/paper.pdf',
    });
    expect(parseReference('not a reference')).toBeNull();
  });
});

describe('fetchArxivMeta', () => {
  it('parses the Atom feed', async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry><id>http://arxiv.org/abs/1706.03762v7</id><title>Attention Is All\n You Need</title>
      <summary>  The dominant sequence transduction models...  </summary><published>2017-06-12T17:57:34Z</published>
      <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
      <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/></entry></feed>`;
    const meta = await fetchArxivMeta(
      '1706.03762',
      (async () => new Response(xml, { status: 200 })) as typeof fetch,
    );
    expect(meta.title).toBe('Attention Is All You Need');
    expect(meta.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(meta.year).toBe(2017);
    expect(meta.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762');
  });
});

describe('downloadPdf', () => {
  it('rejects non-PDF responses with a helpful message', async () => {
    const html = (async () =>
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    await expect(downloadPdf('https://x.test/p', html)).rejects.toThrow(/did not return a PDF/);
  });
  it('accepts PDF bytes and derives a file name', async () => {
    const pdf = (async () =>
      new Response(new TextEncoder().encode('%PDF-1.4 fake'), { status: 200 })) as typeof fetch;
    const out = await downloadPdf('https://x.test/papers/routing.pdf', pdf);
    expect(out.fileName).toBe('routing.pdf');
    expect(out.data.byteLength).toBeGreaterThan(0);
  });
});
