import { downloadPdf, fetchArxivMeta, findPdfUrl, parseReference } from './ingest';

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
    await expect(downloadPdf('https://x.test/p', html)).rejects.toThrow(/does not link to a PDF/);
  });
  it('accepts PDF bytes and derives a file name', async () => {
    const pdf = (async () =>
      new Response(new TextEncoder().encode('%PDF-1.4 fake'), { status: 200 })) as typeof fetch;
    const out = await downloadPdf('https://x.test/papers/routing.pdf', pdf);
    expect(out.fileName).toBe('routing.pdf');
    expect(out.data.byteLength).toBeGreaterThan(0);
  });
});

describe('findPdfUrl', () => {
  it('prefers citation_pdf_url, then alternate links, then download anchors', () => {
    const base = 'https://ojs.aaai.org/index.php/AAAI/article/view/11188/11047';
    expect(
      findPdfUrl(
        '<meta name="citation_pdf_url" content="https://ojs.aaai.org/index.php/AAAI/article/download/11188/11047">',
        base,
      ),
    ).toBe('https://ojs.aaai.org/index.php/AAAI/article/download/11188/11047');
    expect(findPdfUrl('<link rel="alternate" type="application/pdf" href="/files/paper.pdf">', base)).toBe(
      'https://ojs.aaai.org/files/paper.pdf',
    );
    expect(
      findPdfUrl(
        '<a class="obj_galley_link pdf" href="/index.php/AAAI/article/download/11188/11047">PDF</a>',
        base,
      ),
    ).toBe('https://ojs.aaai.org/index.php/AAAI/article/download/11188/11047');
    expect(findPdfUrl('<a href="/about">About</a>', base)).toBeNull();
  });
  it('downloadPdf follows a landing page to its PDF', async () => {
    const calls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      const url = String(u);
      calls.push(url);
      if (url.endsWith('/view/1'))
        return new Response(
          '<html><meta name="citation_pdf_url" content="https://x.test/download/1"></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      return new Response(new TextEncoder().encode('%PDF-1.4 fake'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as typeof fetch;
    const out = await downloadPdf('https://x.test/view/1', f);
    expect(calls).toEqual(['https://x.test/view/1', 'https://x.test/download/1']);
    expect(out.data.byteLength).toBeGreaterThan(0);
  });
});
