import { describe, expect, it, vi } from 'vitest';
import { classifyDriveFile, driveClient, parseDriveFileId } from './client';
import type { TokenSource } from './google-auth';

const INBOX = '1PrV6lIDdZVi5xw_il9mxg3qfFr3pdteH';
const ID = 'AbCdEfGhIjKlMnOp12345';
const cfg = { clientEmail: 'sa@p.iam.gserviceaccount.com', privateKey: 'unused', inboxFolderId: INBOX };

function setup(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn(async (u: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(u)), init ?? {}),
  );
  let n = 0;
  const tokens: TokenSource = { getToken: vi.fn(async () => `tok${++n}`), clear: vi.fn() };
  return {
    fetch,
    tokens,
    client: driveClient(cfg, { fetch: fetch as unknown as typeof globalThis.fetch, tokens }),
  };
}
const jsonRes = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe('parseDriveFileId', () => {
  it.each([
    [ID, ID],
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, ID],
    [`https://docs.google.com/document/d/${ID}/edit`, ID],
    [`https://drive.google.com/open?id=${ID}`, ID],
  ])('%s -> id', (input, id) => expect(parseDriveFileId(input)).toBe(id));

  it.each([
    '../etc',
    'a b',
    '',
    `http://evil.example/file/d/${ID}`,
    `https://evil.example/file/d/${ID}/view`,
    'x'.repeat(300),
  ])('rejects %j', (input) => expect(() => parseDriveFileId(input)).toThrow(/fileId must be/));
});

describe('getMeta', () => {
  it('requests the encoded file with fields and the bearer token, and parses the size', async () => {
    const { client, fetch } = setup(() =>
      jsonRes({
        id: ID,
        name: 'a.pdf',
        mimeType: 'application/pdf',
        size: '12',
        parents: [INBOX],
        sha256Checksum: 'AB',
      }),
    );
    const meta = await client.getMeta(ID);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`https://www.googleapis.com/drive/v3/files/${ID}`);
    expect(u.searchParams.get('fields')).toBe(
      'id,name,mimeType,size,parents,trashed,sha256Checksum,createdTime',
    );
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok1');
    expect(meta).toMatchObject({ id: ID, size: 12, parents: [INBOX], sha256Checksum: 'ab', trashed: false });
  });

  it('encodes the id in the path', async () => {
    const { client, fetch } = setup(() => jsonRes({ id: 'x' }));
    await client.getMeta('a/b?c');
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/files/a%2Fb%3Fc?');
  });

  it.each([404, 403])('maps %i to NOT_VISIBLE', async (status) => {
    const { client } = setup(() => jsonRes({ error: { errors: [{ reason: 'notFound' }] } }, status));
    await expect(client.getMeta(ID)).rejects.toMatchObject({ code: 'NOT_VISIBLE' });
  });

  it('clears the token and retries once on 401, then gives AUTH_REJECTED', async () => {
    const ok = setup((_u, init) =>
      (init.headers as Record<string, string>).authorization === 'Bearer tok1'
        ? jsonRes({}, 401)
        : jsonRes({ id: ID }),
    );
    expect((await ok.client.getMeta(ID)).id).toBe(ID);
    expect(ok.tokens.clear).toHaveBeenCalledTimes(1);
    const bad = setup(() => jsonRes({}, 401));
    await expect(bad.client.getMeta(ID)).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
    expect(bad.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])('maps %i to UNAVAILABLE', async (status) => {
    const { client } = setup(() => jsonRes({}, status));
    await expect(client.getMeta(ID)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('download', () => {
  it('streams the bytes with alt=media', async () => {
    const { client, fetch } = setup(() => new Response(new Uint8Array([1, 2, 3])));
    expect([...(await client.download(ID, 100))]).toEqual([1, 2, 3]);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('alt')).toBe('media');
  });

  it('refuses a content-length over the cap without reading the body', async () => {
    const res = new Response(new Uint8Array(10), { headers: { 'content-length': '999' } });
    const cancel = vi.spyOn(res.body as ReadableStream, 'cancel');
    const { client } = setup(() => res);
    await expect(client.download(ID, 100)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels a body that streams past the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(60));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = setup(() => new Response(stream));
    await expect(client.download(ID, 100)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
});

describe('exportMarkdown', () => {
  it('calls /export as text/markdown', async () => {
    const { client, fetch } = setup(() => new Response('# hi'));
    expect(new TextDecoder().decode(await client.exportMarkdown(ID, 100))).toBe('# hi');
    const u = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(u.pathname.endsWith(`/files/${ID}/export`)).toBe(true);
    expect(u.search).toContain('mimeType=text%2Fmarkdown');
  });
  it('maps 403 exportSizeLimitExceeded to EXPORT_TOO_LARGE', async () => {
    const { client } = setup(() =>
      jsonRes({ error: { errors: [{ reason: 'exportSizeLimitExceeded' }] } }, 403),
    );
    await expect(client.exportMarkdown(ID, 100)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });
});

describe('listInbox', () => {
  it('queries the inbox children that are not trashed', async () => {
    const { client, fetch } = setup(() => jsonRes({ files: [{ id: 'a' }] }));
    expect((await client.listInbox()).map((f) => f.id)).toEqual(['a']);
    const u = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(u.searchParams.get('q')).toBe(`'${INBOX}' in parents and trashed=false`);
    expect(u.searchParams.get('pageSize')).toBe('100');
  });

  it('follows nextPageToken and stops at 5 pages', async () => {
    const { client, fetch } = setup(() => jsonRes({ files: [{ id: 'f' }], nextPageToken: 'more' }));
    expect(await client.listInbox()).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('pageToken')).toBe('more');
  });
});

describe('classifyDriveFile', () => {
  it.each([
    ['application/pdf', 'a.pdf', 'pdf'],
    ['application/octet-stream', 'x.pdf', 'pdf'],
    ['text/markdown', 'a', 'markdown'],
    ['text/x-markdown', 'a', 'markdown'],
    ['text/plain', 'n.md', 'markdown'],
    ['application/octet-stream', 'n.markdown', 'markdown'],
    ['application/vnd.google-apps.document', 'd', 'gdoc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx', 'unsupported'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx', 'unsupported'],
    ['image/png', 'a.png', 'unsupported'],
    ['application/vnd.google-apps.spreadsheet', 's', 'unsupported'],
    ['application/vnd.google-apps.folder', 'f', 'unsupported'],
    ['application/vnd.google-apps.shortcut', 's', 'unsupported'],
    ['text/plain', 'n.txt', 'unsupported'],
  ])('%s %s -> %s', (mimeType, name, kind) => expect(classifyDriveFile({ mimeType, name })).toBe(kind));
});
