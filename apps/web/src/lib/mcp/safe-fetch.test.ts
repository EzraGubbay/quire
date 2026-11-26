// @vitest-environment node
// SSRF guard: pure tests with injected lookup/request, no network.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  assertFetchableUrl,
  FetchRefused,
  type FetchResponse,
  fetchPublicPdf,
  isBlockedAddress,
  makeGuardedLookup,
  type RequestFn,
} from './safe-fetch';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.10.8',
    '100.102.3.115',
    '100.64.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111'])('allows %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('assertFetchableUrl', () => {
  it.each([
    'http://example.com/a.pdf',
    'ftp://example.com/a.pdf',
    'file:///etc/passwd',
    'https://user:pw@example.com/',
    'https://example.com:8443/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::127.0.0.1]/',
    'https://100.102.3.115/x.pdf',
    'not a url',
  ])('rejects %s', (u) => expect(() => assertFetchableUrl(u)).toThrow(FetchRefused));
  it('accepts public https URLs', () => {
    expect(assertFetchableUrl('https://arxiv.org/pdf/1706.03762').hostname).toBe('arxiv.org');
    expect(assertFetchableUrl('https://example.com:443/x.pdf').hostname).toBe('example.com');
  });
});

describe('guarded lookup', () => {
  const run = (resolve: (h: string) => Promise<{ address: string; family: number }[]>, all: boolean) =>
    new Promise<{ err: Error | null; res?: unknown; family?: number }>((done) => {
      const lookup = makeGuardedLookup(resolve);
      const cb = (err: Error | null, res?: unknown, family?: number) => done({ err, res, family });
      if (all) lookup('x.test', { all: true }, cb as never);
      else lookup('x.test', {}, cb as never);
    });
  const pub = [{ address: '93.184.216.34', family: 4 }];
  it('passes public answers in both callback shapes', async () => {
    expect((await run(async () => pub, true)).res).toEqual(pub);
    const single = await run(async () => pub, false);
    expect(single.res).toBe('93.184.216.34');
    expect(single.family).toBe(4);
  });
  it('refuses a mixed public+private answer, a private one and localhost', async () => {
    const mixed = [...pub, { address: '10.0.0.1', family: 4 }];
    expect((await run(async () => mixed, true)).err).toBeInstanceOf(FetchRefused);
    expect((await run(async () => [{ address: '192.168.1.5', family: 4 }], false)).err).toBeInstanceOf(
      FetchRefused,
    );
    expect((await run(async () => [{ address: '127.0.0.1', family: 4 }], false)).err).toBeInstanceOf(
      FetchRefused,
    );
  });
});

// --- fetchPublicPdf with a fake request ---
const PDF = Buffer.from('%PDF-1.7\nbody\n%%EOF');
type Step = {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array[];
  /** keep the stream open forever */
  hang?: boolean;
};
function fake(steps: Step[]) {
  const urls: string[] = [];
  const destroyed = vi.fn();
  const read = vi.fn();
  const request: RequestFn = (url, _opts, onResponse) => {
    urls.push(url.toString());
    const step = steps.shift() ?? { status: 404 };
    const req = Object.assign(new EventEmitter(), { end() {}, destroy: destroyed });
    queueMicrotask(() => {
      let dead = false;
      const res = Object.assign(new EventEmitter(), {
        statusCode: step.status ?? 200,
        headers: step.headers ?? {},
        destroy: (...a: unknown[]) => {
          dead = true;
          destroyed(...a);
        },
      });
      onResponse(res as unknown as FetchResponse);
      if (step.hang) return;
      queueMicrotask(() => {
        for (const c of step.body ?? []) {
          if (dead) return;
          read(c);
          res.emit('data', c);
        }
        if (!dead) res.emit('end');
      });
    });
    return req as never;
  };
  return { request, urls, destroyed, read };
}
const lookup = makeGuardedLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
const go = (steps: Step[], opts = {}) => {
  const f = fake(steps);
  return {
    f,
    p: fetchPublicPdf('https://example.com/dir/Lecture%203', { request: f.request, lookup, ...opts }),
  };
};

describe('default request wiring', () => {
  it('routes the real https.request through the guarded lookup (no network)', async () => {
    const err = await fetchPublicPdf('https://evil.test/x', {
      lookup: makeGuardedLookup(async () => [{ address: '127.0.0.1', family: 4 }]),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FetchRefused);
    expect((err as Error).message).toMatch(/private or local/);
  });
});

describe('fetchPublicPdf', () => {
  it('returns bytes with the filename from content-disposition, then from the path', async () => {
    let { p } = go([
      { headers: { 'content-disposition': 'attachment; filename="slides.pdf"' }, body: [PDF] },
    ]);
    expect((await p).fileName).toBe('slides.pdf');
    ({ p } = go([{ body: [PDF] }]));
    const r = await p;
    expect(r.fileName).toBe('Lecture 3.pdf');
    expect(Buffer.from(r.data).equals(PDF)).toBe(true);
  });

  it('follows a public https redirect, resolving a relative Location', async () => {
    const { f, p } = go([{ status: 302, headers: { location: '/other.pdf' } }, { body: [PDF] }]);
    const r = await p;
    expect(f.urls[1]).toBe('https://example.com/other.pdf');
    expect(r.finalUrl).toBe('https://example.com/other.pdf');
  });

  it('refuses redirects to http, to a metadata address, and past the cap', async () => {
    await expect(go([{ status: 302, headers: { location: 'http://example.com/a.pdf' } }]).p).rejects.toThrow(
      /https/,
    );
    const meta = go([{ status: 302, headers: { location: 'https://169.254.169.254/latest' } }]);
    await expect(meta.p).rejects.toThrow(/private or local/);
    expect(meta.f.urls).toHaveLength(1);
    const loop = go(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })));
    await expect(loop.p).rejects.toThrow(/Too many redirects/);
    expect(loop.f.urls).toHaveLength(4);
  });

  it('errors on a non-200 status', async () => {
    await expect(go([{ status: 404 }]).p).rejects.toThrow(/404/);
  });

  it('refuses a content-length over the cap without reading the body', async () => {
    const { f, p } = go([{ headers: { 'content-length': '1000' }, body: [PDF] }], { maxBytes: 100 });
    await expect(p).rejects.toThrow(/larger/);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.destroyed).toHaveBeenCalled();
  });

  it('destroys a stream that passes the cap with no content-length', async () => {
    const big = Buffer.alloc(80, 65);
    const { f, p } = go([{ body: [big, big] }], { maxBytes: 100 });
    await expect(p).rejects.toThrow(/larger/);
    expect(f.destroyed).toHaveBeenCalled();
  });

  it('times out a stream that never ends', async () => {
    const { p } = go([{ hang: true }], { timeoutMs: 30 });
    await expect(p).rejects.toThrow(/too long/);
  });

  it('explains an HTML page, and rejects other non-PDF bytes', async () => {
    const html = go([{ headers: { 'content-type': 'text/html' }, body: [Buffer.from('<html>')] }]);
    await expect(html.p).rejects.toThrow(/web page, not a PDF/);
    await expect(go([{ body: [Buffer.from('hello')] }]).p).rejects.toThrow(/not a PDF/);
  });

  it('never puts a resolved address in an error', async () => {
    const privLookup = makeGuardedLookup(async () => [{ address: '10.9.8.7', family: 4 }]);
    // A real guarded lookup answers the request's lookup call; emulate that in the fake request.
    const request: RequestFn = (_u, o) => {
      const req = Object.assign(new EventEmitter(), { end() {}, destroy() {} });
      queueMicrotask(() =>
        (o.lookup as never as (h: string, o: object, cb: (e: Error | null) => void) => void)(
          'example.com',
          {},
          (e) => req.emit('error', e),
        ),
      );
      return req as never;
    };
    const err = await fetchPublicPdf('https://example.com/a.pdf', { request, lookup: privLookup }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(FetchRefused);
    expect((err as Error).message).not.toMatch(/10\.9\.8\.7/);
  });
});
