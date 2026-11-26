// @vitest-environment node
// The files.added trigger site (ADR 0003 §1): only a placed, non-duplicate import notifies, after recordFile, with
// the placement's document id; the import never waits on push.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { selects: [] as unknown[][] };
  // A drizzle-ish chain. `select` chains resolve to the next queued result (default []); `insert(...).values(v)`
  // resolves to [{ id: 'lf-9', ...v }] like `.returning()`; `update` chains resolve to [].
  const chain = (root: string, values?: Record<string, unknown>): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop !== 'then')
          return (arg: unknown) => chain(root, prop === 'values' ? (arg as never) : values);
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (root === 'insert') calls.push(`recordFile:${values?.status}`);
          const out =
            root === 'select'
              ? (state.selects.shift() ?? [])
              : root === 'insert'
                ? [{ id: 'lf-9', ...values }]
                : [];
          return Promise.resolve(out).then(res, rej);
        };
      },
    });
  return { calls, state, chain };
});

vi.mock('@/db/client', () => ({ db: new Proxy({}, { get: (_t, root) => () => h.chain(String(root)) }) }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('@/lib/documents', () => ({
  builtinFolder: vi.fn(),
  createDeckDocument: vi.fn(),
  createFolder: vi.fn(async () => ({ id: 'folder-1' })),
  deleteDocument: vi.fn(async () => {}),
  listFolders: vi.fn(async () => []),
}));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn(), sha256: vi.fn(() => 'hash-1') }));
vi.mock('@/lib/homework', () => ({
  createAssignment: vi.fn(),
  nextAssignmentNumber: vi.fn(),
  updateAssignment: vi.fn(),
}));
vi.mock('@/lib/sessions', () => ({
  attachDocumentToSession: vi.fn(),
  createSession: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock('./courses', () => ({ markSynced: vi.fn(async () => {}) }));
vi.mock('./classify', async (orig) => ({
  ...(await orig<typeof import('./classify')>()),
  classifyLemidaFile: vi.fn(),
}));
vi.mock('@/lib/mobile/push/triggers', () => ({ notifyFilesAdded: vi.fn() }));

import type { Project } from '@/db/schema';
import { createDeckDocument } from '@/lib/documents';
import { notifyFilesAdded } from '@/lib/mobile/push/triggers';
import { classifyLemidaFile } from './classify';
import { importLemidaFile } from './import';

const notify = vi.mocked(notifyFilesAdded);
const project = { id: 'p-1', slug: 'signals' } as Project;
const run = () => importLemidaFile(project, { fileName: 'notes.pdf' }, new Uint8Array([1, 2, 3]));
const classifyAs = (kind: string) =>
  vi.mocked(classifyLemidaFile).mockReturnValue({ kind, title: 'Notes', confidence: 1, rule: 'r' } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.state.selects = [];
  classifyAs('other');
  vi.mocked(createDeckDocument).mockResolvedValue({ id: 'doc-9', filePath: null } as never);
  notify.mockImplementation(() => {
    h.calls.push('notify');
    return new Promise(() => {}); // never settles: the import must not wait for it
  });
});

describe('importLemidaFile push trigger', () => {
  it('notifies after recordFile with the placement document id', async () => {
    const r = await run();
    expect(h.calls).toEqual(['recordFile:imported', 'notify']);
    expect(notify).toHaveBeenCalledWith('p-1', r);
    expect(r).toMatchObject({ status: 'imported', duplicate: false, lemidaFileId: 'lf-9' });
    expect(r.placement.documentId).toBe('doc-9');
  });

  it('a needs_review import notifies too', async () => {
    classifyAs('unknown');
    const r = await run();
    expect(r.status).toBe('needs_review');
    expect(notify).toHaveBeenCalledWith('p-1', r);
  });

  it('an already-pulled file (same hash) notifies nothing', async () => {
    h.state.selects = [[{ id: 'lf-1', status: 'imported', placement: { documentId: 'doc-1' } }]];
    expect((await run()).duplicate).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a twin of a hand-uploaded document is recorded as duplicate and notifies nothing', async () => {
    h.state.selects = [[], [], [{ id: 'doc-1' }], [{ id: 'doc-1' }]];
    const r = await run();
    expect(r).toMatchObject({ status: 'duplicate', duplicate: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a failed placement is recorded as error and notifies nothing', async () => {
    vi.mocked(createDeckDocument).mockRejectedValueOnce(new Error('gotenberg down'));
    expect((await run()).status).toBe('error');
    expect(notify).not.toHaveBeenCalled();
  });
});
