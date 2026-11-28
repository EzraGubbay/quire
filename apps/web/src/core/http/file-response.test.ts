// @vitest-environment node
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, contentEtag, etagFor, type FileBody, respondWithFile } from './file-response';

const TEXT = Buffer.from('0123456789ABCDEFGHIJ', 'utf8'); // 20 bytes
let dir: string;
let fileBody: FileBody;
let emptyFileBody: FileBody;
let fileEtag: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-response-'));
  const p = join(dir, 'a.bin');
  await writeFile(p, TEXT);
  await utimes(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const info = await stat(p);
  fileBody = { absPath: p, size: info.size, mtimeMs: info.mtimeMs };
  fileEtag = etagFor(info.size, info.mtimeMs);
  const e = join(dir, 'empty.bin');
  await writeFile(e, '');
  const ei = await stat(e);
  emptyFileBody = { absPath: e, size: 0, mtimeMs: ei.mtimeMs };
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const bytesBody = (): FileBody => ({ bytes: TEXT });
const req = (h: Record<string, string> = {}) => new Request('http://x/f', { headers: h });
const run = (body: FileBody, h: Record<string, string> = {}, extra: object = {}) =>
  respondWithFile({
    req: req(h),
    body,
    contentType: 'text/plain',
    fileName: 'a.txt',
    disposition: 'inline',
    ...extra,
  });
const text = async (r: Response) => Buffer.from(await r.arrayBuffer()).toString('utf8');
const kinds: [string, () => FileBody, string][] = [
  ['bytes', bytesBody, contentEtag(TEXT)],
  ['file', () => fileBody, ''],
];

describe('respondWithFile', () => {
  it('bytes body 200: exact headers and bytes', async () => {
    const res = run(bytesBody());
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      'content-type': 'text/plain',
      'content-disposition': "inline; filename*=UTF-8''a.txt",
      'accept-ranges': 'bytes',
      etag: contentEtag(TEXT),
      'cache-control': 'private, no-cache',
      'content-length': '20',
    });
    expect(await text(res)).toBe(TEXT.toString());
  });

  it('file body 200: streamed bytes, etag from size+mtime', async () => {
    const res = run(fileBody);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(fileEtag);
    expect(res.headers.get('content-length')).toBe('20');
    expect(await text(res)).toBe(TEXT.toString());
  });

  for (const [name, mk] of kinds) {
    describe(`${name} body`, () => {
      it('206 closed, open-ended and suffix ranges', async () => {
        const closed = run(mk(), { range: 'bytes=2-5' });
        expect(closed.status).toBe(206);
        expect(closed.headers.get('content-range')).toBe('bytes 2-5/20');
        expect(closed.headers.get('content-length')).toBe('4');
        expect(await text(closed)).toBe('2345');
        const open = run(mk(), { range: 'bytes=15-' });
        expect(open.headers.get('content-range')).toBe('bytes 15-19/20');
        expect(await text(open)).toBe('FGHIJ');
        const suffix = run(mk(), { range: 'bytes=-3' });
        expect(suffix.headers.get('content-range')).toBe('bytes 17-19/20');
        expect(await text(suffix)).toBe('HIJ');
      });

      it('416: content-range */N, no content-length, empty body', async () => {
        const res = run(mk(), { range: 'bytes=99-100' });
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe('bytes */20');
        expect(res.headers.has('content-length')).toBe(false);
        expect(await text(res)).toBe('');
      });

      it('304 for exact, weak and * If-None-Match; wins over Range', async () => {
        const etag = run(mk()).headers.get('etag') as string;
        for (const inm of [etag, `W/${etag}`, '*']) {
          const res = run(mk(), { 'if-none-match': inm, range: 'bytes=0-1' });
          expect(res.status).toBe(304);
          expect(res.body).toBeNull();
          expect(res.headers.get('etag')).toBe(etag);
          expect(res.headers.has('content-length')).toBe(false);
        }
      });

      it('If-Range: matching etag keeps 206; stale etag or date gives full 200', async () => {
        const etag = run(mk()).headers.get('etag') as string;
        expect(run(mk(), { range: 'bytes=0-1', 'if-range': etag }).status).toBe(206);
        for (const ir of ['"stale"', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
          const res = run(mk(), { range: 'bytes=0-1', 'if-range': ir });
          expect(res.status).toBe(200);
          expect(await text(res)).toBe(TEXT.toString());
        }
      });

      it('multi-range is ignored: 200 full body', async () => {
        const res = run(mk(), { range: 'bytes=0-1,4-5' });
        expect(res.status).toBe(200);
        expect(await text(res)).toBe(TEXT.toString());
      });
    });
  }

  it('size 0: 200 with content-length 0 and empty body; any Range is 416 */0', async () => {
    for (const body of [{ bytes: new Uint8Array(0) }, emptyFileBody]) {
      const res = run(body);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('0');
      expect(await text(res)).toBe('');
      const r = run(body, { range: 'bytes=0-0' });
      expect(r.status).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */0');
    }
  });

  it('overrides: etag, cacheControl and attachment disposition', () => {
    const res = run(
      bytesBody(),
      {},
      { etag: '"custom"', cacheControl: 'no-store', disposition: 'attachment' },
    );
    expect(res.headers.get('etag')).toBe('"custom"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a.txt");
  });
});

describe('contentEtag', () => {
  it('matches the known markdown vector', () => {
    expect(contentEtag(Buffer.from('# Notes: Dijkstra\n\nBody with ünïcode\n', 'utf8'))).toBe(
      '"adddc9d98629f1dfca485a370462207c"',
    );
  });
});

describe('contentDisposition', () => {
  it('percent-encodes non-ASCII names', () => {
    expect(contentDisposition('inline', 'שלום.pdf')).toBe(
      "inline; filename*=UTF-8''%D7%A9%D7%9C%D7%95%D7%9D.pdf",
    );
  });

  it('KNOWN BUG (#108): lone surrogate throws', () => {
    expect(() => contentDisposition('inline', `${'A'.repeat(79)}\uD83D`)).toThrow(URIError);
  });
});
