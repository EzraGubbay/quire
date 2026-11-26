import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveClient, DriveMeta } from './client';
import type { EnabledDriveConfig } from './config';
import { DriveError } from './google-auth';

const hoisted = vi.hoisted(() => ({
  ingestPdf: vi.fn(),
  ingestMarkdown: vi.fn(),
  resolveUploadCourse: vi.fn(),
  resolveFolder: vi.fn(),
  findDuplicatePdf: vi.fn(),
  findDocsByHashes: vi.fn(),
}));
vi.mock('@/lib/documents', () => ({
  createMarkdownDocument: vi.fn(),
  createPdfDocument: vi.fn(),
  listFolders: vi.fn(),
}));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../courses', () => ({ resolveCourse: vi.fn() }));
vi.mock('../upload-store', () => ({
  findNoteByTitle: vi.fn(),
  findMarkdownDoc: vi.fn(),
  findDuplicatePdf: hoisted.findDuplicatePdf,
  setContentHash: vi.fn(),
}));
vi.mock('./store', () => ({ findDocsByHashes: hoisted.findDocsByHashes }));
vi.mock('../upload', async (orig) => ({
  ...(await orig<typeof import('../upload')>()),
  ingestPdf: hoisted.ingestPdf,
  ingestMarkdown: hoisted.ingestMarkdown,
  resolveUploadCourse: hoisted.resolveUploadCourse,
  resolveFolder: hoisted.resolveFolder,
}));

const { driveInboxStatus, importFromDrive } = await import('./import');

const INBOX = '1PrV6lIDdZVi5xw_il9mxg3qfFr3pdteH';
const FID = 'AbCdEfGhIjKlMnOp12345';
const project = { id: 'p1', slug: 'calc', name: 'Calculus', kind: 'course' };
const config: EnabledDriveConfig = {
  enabled: true,
  clientEmail: 'quire-drive-inbox@quire-push.iam.gserviceaccount.com',
  privateKey: '-----BEGIN PRIVATE KEY-----',
  inboxFolderId: INBOX,
  maxPdfBytes: 1000,
  maxMdBytes: 100,
};
const pdfBytes = new TextEncoder().encode('%PDF-1.4 hello');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const meta = (o: Partial<DriveMeta> = {}): DriveMeta => ({
  id: FID,
  name: 'lecture.pdf',
  mimeType: 'application/pdf',
  size: pdfBytes.byteLength,
  parents: [INBOX],
  trashed: false,
  ...o,
});
const created = (o = {}) => ({
  status: 'created',
  section: 'documents',
  course: { slug: 'calc', name: 'Calculus' },
  fileId: 'doc1',
  title: 'Lecture',
  folder: null,
  next: 'Read it back.',
  ...o,
});

function fakeClient(m: DriveMeta, over: Partial<DriveClient> = {}) {
  const client = {
    getMeta: vi.fn(async () => m),
    download: vi.fn(async () => pdfBytes),
    exportMarkdown: vi.fn(async () => new TextEncoder().encode('# From gdoc\n\nBody')),
    listInbox: vi.fn(async () => [m, meta({ id: 'other-file-id-123' })]),
    ...over,
  };
  return client;
}
const run = (args: Partial<Parameters<typeof importFromDrive>[0]>, client: DriveClient, deps = {}) =>
  importFromDrive(
    { fileId: FID, course: 'calc', section: 'documents', ...args },
    { config, client, now: () => Date.parse('2026-11-26T12:00:00Z'), ...deps },
  );

beforeEach(() => {
  vi.resetAllMocks();
  delete (globalThis as { __quireDriveImports?: unknown }).__quireDriveImports;
  delete (globalThis as { __quireDriveInFlight?: unknown }).__quireDriveInFlight;
  hoisted.resolveUploadCourse.mockResolvedValue(project);
  hoisted.resolveFolder.mockResolvedValue({ id: null, name: null });
  hoisted.ingestPdf.mockResolvedValue(created());
  hoisted.ingestMarkdown.mockResolvedValue(created({ title: 'T' }));
  hoisted.findDuplicatePdf.mockResolvedValue(undefined);
  hoisted.findDocsByHashes.mockResolvedValue([]);
});

describe('parent enforcement', () => {
  const NOT_IN = /not in the Quire Inbox/;
  it.each([[['otherFolder']], [['sub']], [undefined]])(
    'refuses parents %j with no download or ingest',
    async (parents) => {
      const c = fakeClient(meta({ parents }));
      await expect(run({}, c)).rejects.toThrow(NOT_IN);
      expect(c.download).not.toHaveBeenCalled();
      expect(hoisted.ingestPdf).not.toHaveBeenCalled();
    },
  );
  it('allows a file with several parents when one is the Inbox', async () => {
    const c = fakeClient(meta({ parents: [INBOX, 'other'] }));
    expect((await run({}, c)).status).toBe('created');
  });
  it('refuses a folder inside the Inbox', async () => {
    const c = fakeClient(meta({ mimeType: 'application/vnd.google-apps.folder' }));
    await expect(run({}, c)).rejects.toThrow(/Quire imports PDFs/);
    expect(c.download).not.toHaveBeenCalled();
  });
});

describe('visibility, trashed, type, section', () => {
  it('gives one not-visible message for 404 and 403', async () => {
    const c = fakeClient(meta(), {
      getMeta: vi.fn(async () => {
        throw new DriveError('NOT_VISIBLE');
      }),
    });
    await expect(run({}, c)).rejects.toThrow(
      `Quire can't see that Drive file. Save it directly in the "Quire Inbox" folder (folder id ${INBOX})`,
    );
  });
  it('trashed with a hash match is a duplicate with the trash instruction', async () => {
    hoisted.findDuplicatePdf.mockResolvedValue({ id: 'docX', title: 'Old', pageCount: 3, fileSize: 14 });
    const c = fakeClient(meta({ trashed: true, sha256Checksum: sha(pdfBytes) }));
    const r = await run({}, c);
    expect(r).toMatchObject({
      status: 'duplicate',
      fileId: 'docX',
      trash: { tool: 'trash_file', fileId: FID },
    });
    expect(c.download).not.toHaveBeenCalled();
  });
  it('trashed with no match is an error', async () => {
    const c = fakeClient(meta({ trashed: true, sha256Checksum: 'ff' }));
    await expect(run({}, c)).rejects.toThrow(/in the Drive trash/);
  });
  it('refuses a PDF into notes before downloading', async () => {
    const c = fakeClient(meta());
    await expect(run({ section: 'notes' }, c)).rejects.toThrow(
      'Notes hold Markdown only; use section "documents" for PDFs.',
    );
    expect(c.download).not.toHaveBeenCalled();
  });
  it('names the mimeType of an unsupported file', async () => {
    const c = fakeClient(meta({ mimeType: 'image/png', name: 'a.png' }));
    await expect(run({}, c)).rejects.toThrow('This file is image/png');
  });
  it('exports a Google Doc and ingests it as Markdown', async () => {
    const c = fakeClient(
      meta({ mimeType: 'application/vnd.google-apps.document', name: 'My doc', size: undefined }),
    );
    await run({ section: 'notes' }, c);
    expect(c.exportMarkdown).toHaveBeenCalledWith(FID, config.maxMdBytes);
    expect(c.download).not.toHaveBeenCalled();
    expect(hoisted.ingestMarkdown).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ section: 'notes', title: 'From gdoc', body: 'Body' }),
    );
  });
});

describe('caps', () => {
  it('refuses a PDF over the cap from metadata, with figures and no download', async () => {
    const c = fakeClient(meta({ size: 5 * 1024 * 1024 }), {});
    await expect(run({}, c, { config: { ...config, maxPdfBytes: 2 * 1024 * 1024 } })).rejects.toThrow(
      'The file is 5.0 MB; Quire imports PDFs up to 2 MB.',
    );
    expect(c.download).not.toHaveBeenCalled();
  });
  it('refuses Markdown over the cap', async () => {
    const c = fakeClient(meta({ mimeType: 'text/markdown', name: 'a.md', size: 500 }));
    await expect(run({}, c)).rejects.toThrow(/Markdown files up to/);
  });
  it('enforces the cap on streamed bytes even when metadata size is wrong', async () => {
    const c = fakeClient(meta({ size: 1 }), {
      download: vi.fn(async () => {
        throw new DriveError('TOO_LARGE');
      }),
    });
    await expect(run({}, c)).rejects.toThrow(/larger than the/);
    expect(c.download).toHaveBeenCalledWith(FID, config.maxPdfBytes);
    expect(hoisted.ingestPdf).not.toHaveBeenCalled();
  });
});

describe('content checks', () => {
  it('rejects bytes without %PDF-', async () => {
    const c = fakeClient(meta(), { download: vi.fn(async () => new TextEncoder().encode('<html>')) });
    await expect(run({}, c)).rejects.toThrow('labelled PDF but its bytes are not a PDF');
    expect(hoisted.ingestPdf).not.toHaveBeenCalled();
  });
  it('rejects a sha256 mismatch', async () => {
    const c = fakeClient(meta({ sha256Checksum: 'a'.repeat(64) }));
    await expect(run({}, c)).rejects.toThrow(/did not match Drive's checksum/);
    expect(hoisted.ingestPdf).not.toHaveBeenCalled();
  });
  it('rejects invalid UTF-8 and empty Markdown', async () => {
    const md = meta({ mimeType: 'text/markdown', name: 'a.md', size: 10 });
    await expect(
      run({}, fakeClient(md, { download: vi.fn(async () => new Uint8Array([0xff, 0xfe, 0x41])) })),
    ).rejects.toThrow(/not valid UTF-8/);
    await expect(
      run({}, fakeClient(md, { download: vi.fn(async () => new TextEncoder().encode('  \n')) })),
    ).rejects.toThrow(/empty/);
    expect(hoisted.ingestMarkdown).not.toHaveBeenCalled();
  });
});

describe('dedupe', () => {
  it('a checksum match in this course is a duplicate with no download', async () => {
    hoisted.findDuplicatePdf.mockResolvedValue({ id: 'docX', title: 'Old', pageCount: 3, fileSize: 14 });
    const c = fakeClient(meta({ sha256Checksum: sha(pdfBytes) }));
    const r = await run({}, c);
    expect(r).toMatchObject({ status: 'duplicate', fileId: 'docX' });
    expect(hoisted.findDuplicatePdf).toHaveBeenCalledWith('p1', sha(pdfBytes), pdfBytes.byteLength);
    expect(c.download).not.toHaveBeenCalled();
    expect(hoisted.ingestPdf).not.toHaveBeenCalled();
  });
  it('a match elsewhere is not a duplicate (the lookup is scoped to this course)', async () => {
    const c = fakeClient(meta({ sha256Checksum: sha(pdfBytes) }));
    expect((await run({}, c)).status).toBe('created');
    expect(c.download).toHaveBeenCalledTimes(1);
  });
  it('two concurrent calls for one fileId download and ingest once', async () => {
    let release!: () => void;
    hoisted.ingestPdf.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(created());
        }),
    );
    const c = fakeClient(meta());
    const a = run({}, c);
    const b = run({}, c);
    await vi.waitFor(() => expect(hoisted.ingestPdf).toHaveBeenCalled());
    release();
    await Promise.all([a, b]);
    expect(c.download).toHaveBeenCalledTimes(1);
    expect(hoisted.ingestPdf).toHaveBeenCalledTimes(1);
  });
  it('a second call after success returns what T2 dedupe says', async () => {
    const c = fakeClient(meta());
    await run({}, c);
    hoisted.ingestPdf.mockResolvedValue(created({ status: 'duplicate' }));
    expect((await run({}, c)).status).toBe('duplicate');
  });
});

describe('ingest arguments', () => {
  it('PDF: project, folder, Drive name, title, and no sourceUrl', async () => {
    const folder = { id: 'f1', name: 'Week 1' };
    hoisted.resolveFolder.mockResolvedValue(folder);
    await run({ title: 'My title', folder: 'Week 1' }, fakeClient(meta()));
    const [p, a] = hoisted.ingestPdf.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(p).toBe(project);
    expect(a).toMatchObject({ fileName: 'lecture.pdf', title: 'My title', folder });
    expect('sourceUrl' in a).toBe(false);
  });
  it('Markdown title order: argument, then H1 (stripped), then the file name', async () => {
    const md = (text: string, name = 'week-3.md') =>
      fakeClient(meta({ mimeType: 'text/markdown', name, size: 20 }), {
        download: vi.fn(async () => new TextEncoder().encode(text)),
      });
    await run({ title: 'Given' }, md('# H1\n\nbody'));
    await run({}, md('# H1\n\nbody'));
    await run({}, md('just text'));
    const titles = hoisted.ingestMarkdown.mock.calls.map((c) => [
      (c[1] as { title: string }).title,
      (c[1] as { body: string }).body,
    ]);
    expect(titles).toEqual([
      ['Given', '# H1\n\nbody'],
      ['H1', 'body'],
      ['week-3', 'just text'],
    ]);
  });
  it('propagates a note-title clash from ingestMarkdown', async () => {
    hoisted.ingestMarkdown.mockRejectedValue(new Error('A note titled "T" already exists'));
    const c = fakeClient(meta({ mimeType: 'text/markdown', name: 'a.md', size: 5 }), {
      download: vi.fn(async () => new TextEncoder().encode('# T\n\nx')),
    });
    await expect(run({ section: 'notes' }, c)).rejects.toThrow(/already exists/);
  });
});

describe('result shape', () => {
  it('names the exact file to trash and counts the other Inbox files', async () => {
    const r = await run({}, fakeClient(meta()));
    expect(r.drive).toEqual({
      fileId: FID,
      name: 'lecture.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.byteLength,
    });
    expect(r.trash).toEqual({ tool: 'trash_file', fileId: FID });
    expect(r.inboxLeftovers).toBe(1);
    expect(r.next).toContain(`trash_file {fileId:"${FID}"}`);
    expect(r.next).toContain('1 other file(s) are still in the Quire Inbox');
  });
  it('omits inboxLeftovers when the listing fails, and still succeeds', async () => {
    const c = fakeClient(meta(), {
      listInbox: vi.fn(async () => {
        throw new DriveError('UNAVAILABLE');
      }),
    });
    const r = await run({}, c);
    expect(r.status).toBe('created');
    expect('inboxLeftovers' in r).toBe(false);
  });
});

describe('deadline', () => {
  it('answers processing without a trash instruction, and a later failure is not unhandled', async () => {
    let fail!: (e: Error) => void;
    hoisted.ingestPdf.mockImplementation(
      () =>
        new Promise((_r, rej) => {
          fail = rej;
        }),
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({}, fakeClient(meta()), { deadlineMs: 5 });
    expect(r.status).toBe('processing');
    expect(r.next).toMatch(/Do NOT trash/);
    expect(r.trash).toBeUndefined();
    fail(new Error('boom'));
    await new Promise((res) => setTimeout(res, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('early errors and secrets', () => {
  it('reports course and folder errors before any Drive call', async () => {
    const c = fakeClient(meta());
    hoisted.resolveUploadCourse.mockRejectedValueOnce(new Error('No course found for "x".'));
    await expect(run({ course: 'x' }, c)).rejects.toThrow(/No course found/);
    hoisted.resolveFolder.mockRejectedValueOnce(new Error('No documents folder "z"'));
    await expect(run({ folder: 'z' }, c)).rejects.toThrow(/No documents folder/);
    await expect(run({ fileId: '../bad' }, c)).rejects.toThrow(/fileId must be/);
    expect(c.getMeta).not.toHaveBeenCalled();
  });

  it('never puts the SA email, key, server paths or token in an error', async () => {
    const cases: [DriveMeta, Partial<DriveClient>][] = [
      [meta({ parents: ['x'] }), {}],
      [meta({ mimeType: 'image/png' }), {}],
      [meta({ trashed: true }), {}],
      [
        meta(),
        {
          getMeta: vi.fn(async () => {
            throw new DriveError('AUTH_REJECTED');
          }),
        },
      ],
      [
        meta(),
        {
          getMeta: vi.fn(async () => {
            throw new DriveError('UNAVAILABLE');
          }),
        },
      ],
      [meta(), { download: vi.fn(async () => new TextEncoder().encode('nope')) }],
    ];
    for (const [m, over] of cases) {
      const e: unknown = await run({}, fakeClient(m, over)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toMatch(/quire-drive-inbox@|BEGIN PRIVATE KEY|\/data\/files|Bearer/);
    }
  });

  it('turns a rejected service account into the misconfigured message', async () => {
    const c = fakeClient(meta(), {
      getMeta: vi.fn(async () => {
        throw new DriveError('AUTH_REJECTED');
      }),
    });
    await expect(run({}, c)).rejects.toThrow("Quire's Google Drive access is misconfigured");
  });
});

describe('driveInboxStatus', () => {
  const now = () => Date.parse('2026-11-26T12:00:00Z');
  const f = (o: Partial<DriveMeta>) => meta({ createdTime: '2026-11-26T09:00:00Z', ...o });

  it('lists files with ageHours and importedAs from a hash match', async () => {
    const c = fakeClient(meta(), {
      listInbox: vi.fn(async () => [
        f({ sha256Checksum: 'aa' }),
        f({ id: 'second-file-id-1', name: 'b.pdf' }),
      ]),
    });
    hoisted.findDocsByHashes.mockResolvedValue([
      { hash: 'aa', projectSlug: 'calc', projectName: 'Calculus', docId: 'doc9', title: 'Lec' },
    ]);
    const r = await driveInboxStatus({ config, client: c, now });
    expect(r.count).toBe(2);
    expect(r.files[0]).toMatchObject({
      ageHours: 3,
      importedAs: { course: 'calc', section: 'documents', fileId: 'doc9', title: 'Lec' },
    });
    expect(r.files[1]?.importedAs).toBeUndefined();
    expect(hoisted.findDocsByHashes).toHaveBeenCalledWith(['aa']);
    expect(r.next).toMatch(/trash each with trash_file/);
    expect(r.next).toMatch(/not imported yet/);
  });

  it('marks a Markdown file just imported via the in-process map', async () => {
    const md = meta({ id: 'md-file-id-12345', mimeType: 'text/markdown', name: 'a.md', size: 5 });
    const c = fakeClient(md, {
      download: vi.fn(async () => new TextEncoder().encode('# T\n\nx')),
      listInbox: vi.fn(async () => [f({ id: md.id, mimeType: 'text/markdown', name: 'a.md' })]),
    });
    hoisted.ingestMarkdown.mockResolvedValue({
      status: 'created',
      section: 'notes',
      course: { slug: 'calc', name: 'Calculus' },
      noteId: 'n1',
      title: 'T',
      folder: null,
      next: 'n',
    });
    await run({ fileId: md.id, section: 'notes' }, c);
    const r = await driveInboxStatus({ config, client: c, now });
    expect(r.files[0]?.importedAs).toEqual({ course: 'calc', section: 'notes', noteId: 'n1', title: 'T' });
    expect(r.next).not.toMatch(/not imported yet/);
  });

  it('says so when the Inbox is empty', async () => {
    const c = fakeClient(meta(), { listInbox: vi.fn(async () => []) });
    const r = await driveInboxStatus({ config, client: c, now });
    expect(r).toMatchObject({ count: 0, next: 'The Quire Inbox is empty.' });
  });
});
