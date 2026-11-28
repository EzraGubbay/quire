// @vitest-environment node
// Characterization (S0.4, quire#105): freezes what S1.1/S1.2 will change. A diff here must be intentional and
// listed in that PR. Handler-level: Next may add framing headers (e.g. content-length) on the wire.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'quire-file-char-'));
process.env.FILES_DIR = tmp; // lib/files.ts reads it at module load

const course = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', name: 'Algo', kind: 'course' };
const research = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'kairos',
  name: 'KAIROS',
  kind: 'research',
};

vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async (s: string) => [research, course].find((p) => p.slug === s)),
  getProjectById: vi.fn(async (id: string) => [research, course].find((p) => p.id === id)),
  listProjects: vi.fn(async () => []),
  projectMeta: vi.fn(() => ({})),
}));
const getDocument = vi.fn();
vi.mock('@/lib/documents', () => ({
  getDocument,
  getDocumentPages: vi.fn(async () => []),
  listDocuments: vi.fn(async () => []),
  countDocuments: vi.fn(async () => 0),
  listFolders: vi.fn(async () => []),
  listPracticeExams: vi.fn(async () => []),
}));
vi.mock('@/lib/sessions', () => ({ listSessions: vi.fn(async () => []), sessionTitle: vi.fn() }));
vi.mock('@/lib/homework', () => ({ listAssignments: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/files', () => ({ lemidaFilesByProject: vi.fn(async () => []) }));
vi.mock('@/lib/mobile/auth', () => ({
  authenticate: vi.fn(async (r: Request) =>
    r.headers.get('authorization') === 'Bearer dev-token'
      ? { tokenId: 'tok-1', deviceName: 'Test phone' }
      : null,
  ),
}));

const webFile = await import('@/app/api/projects/[slug]/documents/[docId]/file/route');
const webOriginal = await import('@/app/api/projects/[slug]/documents/[docId]/original/route');
const mobileContent = await import('@/app/api/mobile/v1/courses/[course]/files/[fileId]/content/route');

// --- Fixtures (synthetic) ---------------------------------------------------------------------------------
const MTIME = new Date('2026-01-01T00:00:00.000Z'); // mtimeMs 1767225600000 = hex 19b76daa800
const PDF = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const ORIG = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7) % 256));
const PDF_ETAG = '"3e8-19b76daa800"';
const ORIG_ETAG = '"258-19b76daa800"';
const MD_ETAG = '"adddc9d98629f1dfca485a370462207c"';
const MD_BODY = '# Notes: Dijkstra\n\nBody with ünïcode\n';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

await mkdir(path.join(tmp, 'p'), { recursive: true });
const disk: Record<string, Buffer> = {
  'p/d-pdf.pdf': PDF,
  'p/d-pdf.pptx': ORIG,
  'p/empty.pdf': Buffer.alloc(0),
  'p/x.zip': Buffer.from('zip!'),
};
for (const [rel, data] of Object.entries(disk)) {
  await writeFile(path.join(tmp, rel), data);
  await utimes(path.join(tmp, rel), MTIME, MTIME);
}
afterAll(() => rm(tmp, { recursive: true, force: true }));

const TITLE = 'Week 3: Graphs / BFS?';
const base = { projectId: course.id, kind: 'pdf', title: TITLE, markdownBody: null, originalName: null };
const DOCS: Record<string, Record<string, unknown>> = {
  dPdf: { ...base, id: 'dPdf', filePath: 'p/d-pdf.pdf', originalPath: 'p/d-pdf.pptx' },
  dNamed: {
    ...base,
    id: 'dNamed',
    filePath: 'p/d-pdf.pdf',
    originalPath: 'p/d-pdf.pptx',
    originalName: 'הרצאה 1.pptx',
  },
  dMd: {
    ...base,
    id: 'dMd',
    kind: 'markdown',
    title: 'Notes: Dijkstra',
    markdownBody: 'Body with ünïcode\n',
    filePath: null,
    originalPath: null,
  },
  dMdNull: { ...base, id: 'dMdNull', kind: 'markdown', title: 'T', filePath: null, originalPath: null },
  dDeckOnly: { ...base, id: 'dDeckOnly', filePath: null, originalPath: 'p/d-pdf.pptx' },
  dMissing: { ...base, id: 'dMissing', filePath: 'p/missing.pdf', originalPath: 'p/missing.pptx' },
  dEmpty: { ...base, id: 'dEmpty', filePath: 'p/empty.pdf', originalPath: null },
  dZip: { ...base, id: 'dZip', filePath: 'p/d-pdf.pdf', originalPath: 'p/x.zip' },
  dResearch: {
    ...base,
    id: 'dResearch',
    projectId: research.id,
    filePath: 'p/d-pdf.pdf',
    originalPath: null,
  },
};
const titled = (id: string, title: string) => {
  DOCS[id] = { ...base, id, title, filePath: 'p/d-pdf.pdf', originalPath: null };
};
titled('tQ', '???');
titled('tLong', 'A'.repeat(100));
titled('tHe', 'הרצאה 3');
titled('tEmoji', `${'A'.repeat(79)}😀`);

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockImplementation(async (projectId: string, id: string) => {
    const d = DOCS[id];
    return d && d.projectId === projectId ? d : undefined;
  });
});

// --- Helpers ----------------------------------------------------------------------------------------------
const ctx = <T extends object>(o: T) => ({ params: Promise.resolve(o) });
const get = (url: string, headers?: Record<string, string>) =>
  new Request(`http://x${url}`, headers ? { headers } : undefined);
const headersOf = (res: Response) => Object.fromEntries(res.headers);
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());
const AUTH = { authorization: 'Bearer dev-token' };

const callWebFile = (docId: string, query = '', headers?: Record<string, string>, slug = 'algo') =>
  webFile.GET(get(`/api/projects/${slug}/documents/${docId}/file${query}`, headers), ctx({ slug, docId }));
const callWebOriginal = (docId: string, query = '', headers?: Record<string, string>, slug = 'algo') =>
  webOriginal.GET(
    get(`/api/projects/${slug}/documents/${docId}/original${query}`, headers),
    ctx({ slug, docId }),
  );
const callMobile = (fileId: string, query = '', headers: Record<string, string> = AUTH, courseRef = 'algo') =>
  mobileContent.GET(
    get(`/api/mobile/v1/courses/${courseRef}/files/${fileId}/content${query}`, headers),
    ctx({ course: courseRef, fileId }),
  );

const PDF_NAME = "UTF-8''Week%203%20%20Graphs%20%20%20BFS";
const WEB_PDF_HEADERS = {
  'content-type': 'application/pdf',
  'content-length': '1000',
  'content-disposition': `inline; filename*=${PDF_NAME}.pdf`,
  'cache-control': 'private, max-age=3600',
};
const MOBILE_BASE = {
  'content-type': 'application/pdf',
  'content-disposition': `inline; filename*=${PDF_NAME}.pdf`,
  'accept-ranges': 'bytes',
  etag: PDF_ETAG,
  'cache-control': 'private, no-cache',
};
const mobileErr = async (res: Response, status: number, code: string, message: string) => {
  expect(res.status).toBe(status);
  expect(headersOf(res)).toEqual({ 'content-type': 'application/json' });
  expect(await res.json()).toEqual({ error: { code, message } });
};

// --- Web: documents/[docId]/file ----------------------------------------------------------------------------
describe('web documents/[docId]/file', () => {
  it('serves a pdf inline with full headers and identical bytes', async () => {
    const res = await callWebFile('dPdf');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(WEB_PDF_HEADERS);
    expect(await bytes(res)).toEqual(PDF);
    expect(getDocument).toHaveBeenCalledWith(course.id, 'dPdf');
  });

  it('?download=1 sends attachment; any non-empty value does too (?download=0); empty stays inline', async () => {
    for (const q of ['?download=1', '?download=0']) {
      const res = await callWebFile('dPdf', q);
      expect(res.status).toBe(200);
      expect(headersOf(res)).toEqual({
        ...WEB_PDF_HEADERS,
        'content-disposition': `attachment; filename*=${PDF_NAME}.pdf`,
      });
      expect(await bytes(res)).toEqual(PDF);
    }
    const empty = await callWebFile('dPdf', '?download=');
    expect(headersOf(empty)).toEqual(WEB_PDF_HEADERS);
  });

  it('ignores Range: 200 with the full body and no range, etag or accept-ranges headers', async () => {
    const res = await callWebFile('dPdf', '', { range: 'bytes=0-99' });
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(WEB_PDF_HEADERS);
    expect(await bytes(res)).toEqual(PDF);
  });

  it('serves markdown with no content-length and no-store', async () => {
    const res = await callWebFile('dMd');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': "inline; filename*=UTF-8''Notes%20%20Dijkstra.md",
      'cache-control': 'private, no-store',
    });
    expect(await res.text()).toBe(MD_BODY);
  });

  it('markdown with a null body is just the heading; Range is ignored', async () => {
    expect(await (await callWebFile('dMdNull')).text()).toBe('# T\n\n');
    const res = await callWebFile('dMd', '', { range: 'bytes=0-9' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MD_BODY);
  });

  it('has no kind check: a research project serves by slug', async () => {
    const res = await callWebFile('dResearch', '', undefined, 'kairos');
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(PDF);
    expect(getDocument).toHaveBeenCalledWith(research.id, 'dResearch');
  });

  it.each([
    ['unknown slug', () => callWebFile('dPdf', '', undefined, 'nope'), 'Not found'],
    ['unknown docId', () => callWebFile('zzz'), 'Not found'],
    ['deck-only document (no pdf)', () => callWebFile('dDeckOnly'), 'Not found'],
    ['pdf missing on disk', () => callWebFile('dMissing'), 'File missing'],
  ])('404 for %s', async (_n, call, text) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(headersOf(res)).toEqual({ 'content-type': 'text/plain;charset=UTF-8' });
    expect(await res.text()).toBe(text);
  });

  it.each([
    ['tQ', 'document.pdf'],
    ['tLong', `${'A'.repeat(80)}.pdf`],
    ['tHe', '%D7%94%D7%A8%D7%A6%D7%90%D7%94%203.pdf'],
  ])('filename for title variant %s', async (id, name) => {
    const res = await callWebFile(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''${name}`);
  });

  it('KNOWN BUG: an emoji straddling the 80-unit truncation throws URIError (500); see #108', async () => {
    await expect(callWebFile('tEmoji')).rejects.toThrow(URIError);
  });
});

// --- Web: documents/[docId]/original --------------------------------------------------------------------------
describe('web documents/[docId]/original', () => {
  const ORIG_HEADERS = {
    'content-type': PPTX,
    'content-length': '600',
    'content-disposition': "attachment; filename*=UTF-8''Week%203%3A%20Graphs%20%2F%20BFS%3F.pptx",
    'cache-control': 'private, max-age=3600',
  };

  it('serves the deck as attachment named from the RAW title (not safeName)', async () => {
    const res = await callWebOriginal('dPdf');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(ORIG_HEADERS);
    expect(await bytes(res)).toEqual(ORIG);
  });

  it('prefers originalName', async () => {
    const res = await callWebOriginal('dNamed');
    expect(headersOf(res)).toEqual({
      ...ORIG_HEADERS,
      'content-disposition': "attachment; filename*=UTF-8''%D7%94%D7%A8%D7%A6%D7%90%D7%94%201.pptx",
    });
    expect(await bytes(res)).toEqual(ORIG);
  });

  it('ignores download/inline query and Range', async () => {
    for (const q of ['?download=', '?inline=1']) {
      expect(headersOf(await callWebOriginal('dPdf', q))).toEqual(ORIG_HEADERS);
    }
    const res = await callWebOriginal('dPdf', '', { range: 'bytes=0-9' });
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(ORIG_HEADERS);
    expect(await bytes(res)).toEqual(ORIG);
  });

  it('unknown extension is application/octet-stream', async () => {
    const res = await callWebOriginal('dZip');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''Week%203%3A%20Graphs%20%2F%20BFS%3F.zip",
    );
  });

  it.each([
    ['no originalPath', () => callWebOriginal('dMd'), 'Not found'],
    ['unknown slug', () => callWebOriginal('dPdf', '', undefined, 'nope'), 'Not found'],
    ['unknown doc', () => callWebOriginal('zzz'), 'Not found'],
    ['original missing on disk', () => callWebOriginal('dMissing'), 'File missing'],
  ])('404 for %s', async (_n, call, text) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(text);
  });
});

// --- Mobile: courses/[course]/files/[fileId]/content ---------------------------------------------------------
describe('mobile courses/[course]/files/[fileId]/content', () => {
  it('401 without a bearer; auth runs before validation and before any data access', async () => {
    for (const q of ['', '?format=bogus']) {
      const res = await callMobile('dPdf', q, {});
      expect(res.status).toBe(401);
      expect(headersOf(res)).toEqual({ 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      expect(await res.json()).toEqual({
        error: { code: 'unauthorized', message: 'Missing, invalid or revoked device token' },
      });
    }
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('400 for an unknown format', async () => {
    await mobileErr(
      await callMobile('dPdf', '?format=bogus'),
      400,
      'invalid_request',
      'format must be one of pdf, original, markdown',
    );
  });

  it('serves the pdf with ETag, accept-ranges and identical bytes (by slug and by UUID)', async () => {
    for (const ref of ['algo', course.id]) {
      const res = await callMobile('dPdf', '', AUTH, ref);
      expect(res.status).toBe(200);
      expect(headersOf(res)).toEqual({ ...MOBILE_BASE, 'content-length': '1000' });
      expect(await bytes(res)).toEqual(PDF);
    }
  });

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=900-', 900, 999],
    ['bytes=-100', 900, 999],
    ['bytes=10-5000', 10, 999],
  ])('Range %s answers 206', async (range, s, e) => {
    const res = await callMobile('dPdf', '', { ...AUTH, range });
    expect(res.status).toBe(206);
    expect(headersOf(res)).toEqual({
      ...MOBILE_BASE,
      'content-range': `bytes ${s}-${e}/1000`,
      'content-length': String(e - s + 1),
    });
    expect(await bytes(res)).toEqual(PDF.subarray(s, e + 1));
  });

  it('an unsatisfiable Range answers 416 with no content-length and an empty body', async () => {
    const res = await callMobile('dPdf', '', { ...AUTH, range: 'bytes=5000-' });
    expect(res.status).toBe(416);
    expect(headersOf(res)).toEqual({ ...MOBILE_BASE, 'content-range': 'bytes */1000' });
    expect((await bytes(res)).length).toBe(0);
  });

  it('a multi-range request is ignored (200, full body)', async () => {
    const res = await callMobile('dPdf', '', { ...AUTH, range: 'bytes=0-1,5-9' });
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({ ...MOBILE_BASE, 'content-length': '1000' });
    expect(await bytes(res)).toEqual(PDF);
  });

  it.each([PDF_ETAG, `W/${PDF_ETAG}`, '*'])(
    'If-None-Match %s answers 304 with base headers only',
    async (inm) => {
      const res = await callMobile('dPdf', '', { ...AUTH, 'if-none-match': inm });
      expect(res.status).toBe(304);
      expect(headersOf(res)).toEqual(MOBILE_BASE);
      expect(res.body).toBeNull();
    },
  );

  it('a non-matching If-None-Match serves 200; a matching one wins over Range', async () => {
    const miss = await callMobile('dPdf', '', { ...AUTH, 'if-none-match': '"nope"' });
    expect(miss.status).toBe(200);
    const hit = await callMobile('dPdf', '', { ...AUTH, 'if-none-match': PDF_ETAG, range: 'bytes=0-9' });
    expect(hit.status).toBe(304);
  });

  it('If-Range: matching etag honours Range; stale etag or a date serves the full body', async () => {
    const ok = await callMobile('dPdf', '', { ...AUTH, 'if-range': PDF_ETAG, range: 'bytes=0-9' });
    expect(ok.status).toBe(206);
    expect(await bytes(ok)).toEqual(PDF.subarray(0, 10));
    for (const ir of ['"stale"', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const res = await callMobile('dPdf', '', { ...AUTH, 'if-range': ir, range: 'bytes=0-9' });
      expect(res.status).toBe(200);
      expect(headersOf(res)).toEqual({ ...MOBILE_BASE, 'content-length': '1000' });
      expect(await bytes(res)).toEqual(PDF);
    }
  });

  it('format=original serves the deck inline, named from safeTitle', async () => {
    const res = await callMobile('dPdf', '?format=original');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      ...MOBILE_BASE,
      'content-type': PPTX,
      'content-disposition': `inline; filename*=${PDF_NAME}.pptx`,
      etag: ORIG_ETAG,
      'content-length': '600',
    });
    expect(await bytes(res)).toEqual(ORIG);
  });

  it('format=original prefers originalName', async () => {
    const res = await callMobile('dNamed', '?format=original');
    expect(res.headers.get('content-disposition')).toBe(
      "inline; filename*=UTF-8''%D7%94%D7%A8%D7%A6%D7%90%D7%94%201.pptx",
    );
  });

  it('format=markdown serves the body with a content-hash ETag and honours Range', async () => {
    const res = await callMobile('dMd', '?format=markdown');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': "inline; filename*=UTF-8''Notes%20%20Dijkstra.md",
      'accept-ranges': 'bytes',
      etag: MD_ETAG,
      'cache-control': 'private, no-cache',
      'content-length': '39',
    });
    expect(await res.text()).toBe(MD_BODY);

    const part = await callMobile('dMd', '?format=markdown', { ...AUTH, range: 'bytes=0-9' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-9/39');
    expect(await part.text()).toBe('# Notes: D');
  });

  it('errors map to 404 not_found JSON with the resolver message', async () => {
    await mobileErr(await callMobile('dMd'), 404, 'not_found', 'This file has no PDF.');
    await mobileErr(await callMobile('dDeckOnly'), 404, 'not_found', 'This file has no PDF.');
    await mobileErr(
      await callMobile('dPdf', '?format=markdown'),
      404,
      'not_found',
      'This file has no markdown body.',
    );
    await mobileErr(
      await callMobile('dMd', '?format=original'),
      404,
      'not_found',
      'This file has no original (pptx/key/odp) upload.',
    );
    await mobileErr(await callMobile('dMissing'), 404, 'not_found', 'File is missing on disk.');
    await mobileErr(
      await callMobile('dResearch', '', AUTH, 'kairos'),
      404,
      'not_found',
      'No course found for "kairos"',
    );
    await mobileErr(
      await callMobile('dPdf', '', AUTH, 'nope'),
      404,
      'not_found',
      'No course found for "nope"',
    );
    await mobileErr(await callMobile('zzz'), 404, 'not_found', 'No file "zzz" in course "algo"');
  });

  it('deck-only document: original works', async () => {
    const res = await callMobile('dDeckOnly', '?format=original');
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(ORIG);
  });

  it('an empty file is 200 with content-length 0; any Range on it is 416', async () => {
    const res = await callMobile('dEmpty');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual({ ...MOBILE_BASE, etag: '"0-19b76daa800"', 'content-length': '0' });
    expect((await bytes(res)).length).toBe(0);
    const ranged = await callMobile('dEmpty', '', { ...AUTH, range: 'bytes=0-' });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });

  it('KNOWN BUG: an emoji straddling the 80-unit truncation throws URIError (500); see #108', async () => {
    await expect(callMobile('tEmoji')).rejects.toThrow(URIError);
  });
});

// --- Divergences: the inputs S1.2 must resolve ("desktop wins") ----------------------------------------------
describe('web vs mobile divergences (inputs to S1.2)', () => {
  it('pdf cache-control: web max-age=3600, mobile no-cache', async () => {
    expect((await callWebFile('dPdf')).headers.get('cache-control')).toBe('private, max-age=3600');
    expect((await callMobile('dPdf')).headers.get('cache-control')).toBe('private, no-cache');
  });

  it('markdown cache-control: web no-store, mobile no-cache', async () => {
    expect((await callWebFile('dMd')).headers.get('cache-control')).toBe('private, no-store');
    expect((await callMobile('dMd', '?format=markdown')).headers.get('cache-control')).toBe(
      'private, no-cache',
    );
  });

  it('accept-ranges and etag: absent on web, present on mobile', async () => {
    const w = await callWebFile('dPdf');
    const m = await callMobile('dPdf');
    expect(w.headers.has('accept-ranges')).toBe(false);
    expect(w.headers.has('etag')).toBe(false);
    expect(m.headers.get('accept-ranges')).toBe('bytes');
    expect(m.headers.get('etag')).toBe(PDF_ETAG);
  });

  it('original disposition: web attachment, mobile inline', async () => {
    expect((await callWebOriginal('dPdf')).headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await callMobile('dPdf', '?format=original')).headers.get('content-disposition')).toMatch(
      /^inline;/,
    );
  });

  it('original fallback filename: web raw title, mobile safeTitle', async () => {
    expect((await callWebOriginal('dPdf')).headers.get('content-disposition')).toContain(
      'Week%203%3A%20Graphs%20%2F%20BFS%3F.pptx',
    );
    expect((await callMobile('dPdf', '?format=original')).headers.get('content-disposition')).toContain(
      `${PDF_NAME}.pptx`,
    );
  });

  it('agreement: inline pdf and markdown content-disposition are equal', async () => {
    expect((await callWebFile('dPdf')).headers.get('content-disposition')).toBe(
      (await callMobile('dPdf')).headers.get('content-disposition'),
    );
    expect((await callWebFile('dMd')).headers.get('content-disposition')).toBe(
      (await callMobile('dMd', '?format=markdown')).headers.get('content-disposition'),
    );
  });

  it('agreement: markdown and pdf bytes are equal', async () => {
    expect(await (await callWebFile('dMd')).text()).toBe(
      await (await callMobile('dMd', '?format=markdown')).text(),
    );
    expect(await bytes(await callWebFile('dPdf'))).toEqual(await bytes(await callMobile('dPdf')));
  });
});
