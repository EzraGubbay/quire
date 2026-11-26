// @vitest-environment node
// Retrying a failed import (bug 12): an error row is upserted in place, a non-error row is never re-imported or
// overwritten, and a document this attempt created is deleted when placement fails or the race is lost.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserts: [] as unknown[][], // queued `.returning()` results; empty queue -> echo the values as a new row
    upserts: [] as Record<string, unknown>[],
    values: [] as Record<string, unknown>[],
    updates: [] as unknown[][], // queued `.returning()` results of a status update (the #66 release)
    releases: [] as Record<string, unknown>[], // `.set()` payloads of status updates, in order
    calls: [] as string[], // ordered 'delete' / 'release' log
  };
  const chain = (root: string, values?: Record<string, unknown>, set?: Record<string, unknown>): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop !== 'then')
          return (arg: unknown) => {
            if (prop === 'onConflictDoUpdate') state.upserts.push(arg as never);
            if (prop === 'values') state.values.push(arg as never);
            if (prop === 'set' && root === 'update' && 'status' in (arg as object)) {
              state.releases.push(arg as never);
              state.calls.push('release');
            }
            return chain(
              root,
              prop === 'values' ? (arg as never) : values,
              prop === 'set' ? (arg as never) : set,
            );
          };
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const out =
            root === 'select'
              ? (state.selects.shift() ?? [])
              : root === 'insert'
                ? (state.inserts.shift() ?? [{ id: 'lf-9', ...values }])
                : root === 'update' && set && 'status' in set
                  ? (state.updates.shift() ?? [])
                  : [];
          return Promise.resolve(out).then(res, rej);
        };
      },
    });
  return { state, chain };
});

vi.mock('@/db/client', () => ({ db: new Proxy({}, { get: (_t, root) => () => h.chain(String(root)) }) }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('@/lib/documents', () => ({
  builtinFolder: vi.fn(),
  createDeckDocument: vi.fn(),
  createFolder: vi.fn(async () => ({ id: 'folder-1' })),
  deleteDocument: vi.fn(async () => {
    h.state.calls.push('delete');
  }),
  listFolders: vi.fn(async () => []),
}));
vi.mock('@/lib/files', () => ({ readStoredFile: vi.fn(), sha256: vi.fn(() => 'hash-1') }));
vi.mock('@/lib/homework', () => ({
  createAssignment: vi.fn(async () => ({ id: 'a-1', sheetDocumentId: null, dueAt: null })),
  nextAssignmentNumber: vi.fn(async () => 1),
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

import { lemidaFiles, type Project } from '@/db/schema';
import { createDeckDocument, deleteDocument } from '@/lib/documents';
import { updateAssignment } from '@/lib/homework';
import { notifyFilesAdded } from '@/lib/mobile/push/triggers';
import { classifyLemidaFile } from './classify';
import { importLemidaFile } from './import';

const project = { id: 'p-1', slug: 'signals' } as Project;
const run = () => importLemidaFile(project, { fileName: 'notes.pdf' }, new Uint8Array([1, 2, 3]));
const classifyAs = (kind: string) =>
  vi.mocked(classifyLemidaFile).mockReturnValue({ kind, title: 'Notes', confidence: 1, rule: 'r' } as never);
const winner = { id: 'lf-1', status: 'imported', placement: { documentId: 'doc-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selects = [];
  h.state.inserts = [];
  h.state.upserts = [];
  h.state.values = [];
  h.state.updates = [];
  h.state.releases = [];
  h.state.calls = [];
  classifyAs('other');
  vi.mocked(createDeckDocument).mockResolvedValue({ id: 'doc-9', filePath: null } as never);
  vi.mocked(notifyFilesAdded).mockResolvedValue(undefined as never);
});

describe('importLemidaFile retry', () => {
  it('a first import upserts on (project, sha256) guarded to error rows and deletes nothing', async () => {
    const r = await run();
    expect(r).toMatchObject({ status: 'imported', duplicate: false, error: null });
    expect(h.state.upserts).toHaveLength(1);
    const up = h.state.upserts[0] as { target: unknown[]; setWhere: unknown };
    expect(up.target).toEqual([lemidaFiles.projectId, lemidaFiles.sha256]);
    expect(up.setWhere).toBeDefined();
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it.each(['imported', 'duplicate', 'needs_review'])(
    'a prior %s row is a duplicate: no placement, no write',
    async (status) => {
      h.state.selects = [[{ id: 'lf-1', status, placement: {}, error: null }]];
      const r = await run();
      expect(r).toMatchObject({ duplicate: true, status, lemidaFileId: 'lf-1' });
      expect(createDeckDocument).not.toHaveBeenCalled();
      expect(h.state.values).toHaveLength(0);
    },
  );

  it('a prior error row is re-run', async () => {
    h.state.selects = [[{ id: 'lf-1', status: 'error' }]];
    const r = await run();
    expect(createDeckDocument).toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'imported', duplicate: false, error: null });
  });

  it('a failure after the document was created deletes it and clears the placement', async () => {
    classifyAs('homework');
    vi.mocked(updateAssignment).mockRejectedValueOnce(new Error('db hiccup'));
    const r = await run();
    expect(r).toMatchObject({ status: 'error', error: 'db hiccup' });
    expect(deleteDocument).toHaveBeenCalledWith('p-1', 'doc-9');
    const recorded = h.state.values.at(-1) as { placement: { documentId?: string } };
    expect(recorded.placement.documentId).toBeUndefined();
    // #66: after the delete, release any row another import pointed at the deleted document.
    expect(h.state.calls).toEqual(['delete', 'release']);
    expect(h.state.releases).toHaveLength(1);
    expect(h.state.releases[0]).toMatchObject({ status: 'error', error: 'db hiccup' });
  });

  it('a failure before any document exists deletes nothing', async () => {
    vi.mocked(createDeckDocument).mockRejectedValueOnce(new Error('gotenberg down'));
    const r = await run();
    expect(r.status).toBe('error');
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(h.state.releases).toHaveLength(0); // the release is gated on a created document
  });

  it("a lost race on the success path deletes this attempt's document and reports the winner", async () => {
    h.state.inserts = [[]];
    h.state.selects = [[], [], [], [winner]];
    const r = await run();
    expect(r).toMatchObject({ duplicate: true, lemidaFileId: 'lf-1', status: 'imported' });
    expect(deleteDocument).toHaveBeenCalledWith('p-1', 'doc-9');
    expect(notifyFilesAdded).not.toHaveBeenCalled();
  });

  it('a lost race on the error path reports the winner, not an error', async () => {
    vi.mocked(createDeckDocument).mockRejectedValueOnce(new Error('boom'));
    h.state.inserts = [[]];
    h.state.selects = [[], [], [], [winner]];
    const r = await run();
    expect(r).toMatchObject({ duplicate: true, status: 'imported', lemidaFileId: 'lf-1' });
    expect(h.state.releases).toHaveLength(0);
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('a lost race whose winner adopted our document keeps it', async () => {
    h.state.inserts = [[]];
    h.state.selects = [[], [], [], [{ id: 'lf-1', status: 'duplicate', placement: { documentId: 'doc-9' } }]];
    const r = await run();
    expect(r).toMatchObject({ duplicate: true, lemidaFileId: 'lf-1' });
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('a failure after the winner adopted our document keeps it', async () => {
    classifyAs('homework');
    vi.mocked(updateAssignment).mockRejectedValueOnce(new Error('db hiccup'));
    h.state.inserts = [[]];
    h.state.selects = [
      [],
      [],
      [],
      [],
      [{ id: 'lf-1', status: 'duplicate', placement: { documentId: 'doc-9' } }],
    ];
    const r = await run();
    expect(r).toMatchObject({ duplicate: true, status: 'duplicate' });
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(h.state.releases).toHaveLength(0);
  });

  describe('twin path (#66)', () => {
    const TWIN_GONE = 'the matching document was deleted during import; will retry';

    it('a twin that still exists is a duplicate with no release', async () => {
      h.state.selects = [[], [], [{ id: 'doc-1' }], [{ id: 'doc-1' }]];
      const r = await run();
      expect(r).toMatchObject({ status: 'duplicate', duplicate: true });
      expect(h.state.releases).toHaveLength(0);
    });

    it('a twin that is gone is released and reported as a retryable error', async () => {
      h.state.selects = [[], [], [{ id: 'doc-1' }], []];
      h.state.updates = [[{ id: 'lf-9', status: 'error', error: TWIN_GONE, placement: {} }]];
      const r = await run();
      expect(r).toMatchObject({ status: 'error', duplicate: false, error: TWIN_GONE });
      expect(h.state.releases).toHaveLength(1);
      expect(h.state.releases[0]).toMatchObject({ status: 'error', error: TWIN_GONE });
    });

    it('a twin that is gone but already released elsewhere re-reads the row', async () => {
      const errRow = { id: 'lf-9', status: 'error', error: 'db hiccup', placement: {} };
      h.state.selects = [[], [], [{ id: 'doc-1' }], [], [errRow]];
      const r = await run();
      expect(r).toMatchObject({ status: 'error', duplicate: false, lemidaFileId: 'lf-9' });
      expect(h.state.releases).toHaveLength(1);
    });
  });
});
