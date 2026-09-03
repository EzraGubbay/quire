import { guessType, htmlToText, snapshotUrl } from './sources';

describe('sources', () => {
  it('strips html to text', () => {
    expect(
      htmlToText(
        '<html><head><style>x{}</style><script>1</script></head><body><h1>Hi &amp; bye</h1><p>a<br>b</p></body></html>',
      ),
    ).toBe('Hi & bye\na\nb');
  });
  it('guesses a type from the host', () => {
    expect(guessType('github.com')).toBe('repo');
    expect(guessType('youtube.com')).toBe('video');
    expect(guessType('example.org')).toBe('web');
  });
  it('snapshots a page', async () => {
    const f = (async () =>
      new Response('<html><head><title> A page </title></head><body><p>Body text</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;
    const out = await snapshotUrl('https://example.org/x', f);
    expect(out.title).toBe('A page');
    expect(out.text).toContain('Body text');
  });
});
