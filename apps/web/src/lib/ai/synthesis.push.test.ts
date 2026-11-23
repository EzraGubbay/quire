// @vitest-environment node
// The note.synthesized trigger site (ADR 0003 §1): `ready` only after syncLinks, `failed` inside fail(), nothing
// from the boot-time stale cleanup, and the run never waits on push.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { dbRows: [] as unknown[] };
  // A drizzle-ish chain: every method returns the chain; awaiting it yields `state.dbRows`.
  const chain = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(state.dbRows).then(res, rej)
          : () => chain(),
    });
  return { calls, state, chain };
});

vi.mock('@/db/client', () => ({ db: new Proxy({}, { get: () => () => h.chain() }) }));
vi.mock('@/lib/documents', () => ({ builtinFolder: vi.fn() }));
vi.mock('@/lib/macros', () => ({ mergedMacros: vi.fn(async () => []) }));
vi.mock('@/lib/notes', () => ({
  createNote: vi.fn(),
  getNote: vi.fn(),
  syncLinks: vi.fn(),
  updateNote: vi.fn(),
}));
vi.mock('@/lib/projects', () => ({
  getProjectById: vi.fn(async () => ({ id: 'p-1', name: 'Signals', description: '' })),
  projectMeta: vi.fn(() => ({ type: 'theory' })),
}));
vi.mock('@/lib/sessions', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/slides', () => ({ IMAGE_TOKENS_HIGH: 1, renderPageImages: vi.fn(), slideDataUrl: vi.fn() }));
vi.mock('./index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('./ledger', () => ({
  assertBudget: vi.fn(),
  estimateTokens: vi.fn(),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('./prompts/synthesis', () => ({ buildSynthesisPrompt: vi.fn(() => ({ system: 's', user: 'u' })) }));
vi.mock('./provider', () => ({
  chat: vi.fn(),
  ProviderError: class ProviderError extends Error {
    kind = 'x';
  },
}));
vi.mock('./settings', () => ({
  costFor: vi.fn(),
  getAiSettings: vi.fn(async () => ({ models: { synthesis: 'm' } })),
}));
vi.mock('@/lib/mobile/push/triggers', () => ({ notifyNoteSynthesized: vi.fn() }));

import { notifyNoteSynthesized } from '@/lib/mobile/push/triggers';
import { getNote, syncLinks, updateNote } from '@/lib/notes';
import { chat } from './provider';
import { failStaleGenerating, runSynthesis } from './synthesis';

const notify = vi.mocked(notifyNoteSynthesized);
const readyAt = new Date('2026-11-24T09:05:00.000Z');
const failedAt = new Date('2026-11-24T09:06:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.state.dbRows = [{ toId: 'raw-1' }]; // synthesizedFrom's link lookup
  vi.mocked(getNote).mockImplementation(async (_p, id) =>
    id === 'raw-1'
      ? ({ id, title: 'Raw', body: 'raw body', sessionId: null } as never)
      : ({ id, title: 'Target' } as never),
  );
  vi.mocked(chat).mockResolvedValue({ text: 'synthesized', model: 'm', usage: {} } as never);
  vi.mocked(updateNote).mockImplementation(async (_p, id, patch) => {
    h.calls.push(`updateNote:${patch.status}`);
    return { id, status: patch.status, updatedAt: patch.status === 'ready' ? readyAt : failedAt } as never;
  });
  vi.mocked(syncLinks).mockImplementation(async () => {
    h.calls.push('syncLinks');
  });
  notify.mockImplementation((_p, _n, outcome) => {
    h.calls.push(`notify:${outcome}`);
    return new Promise(() => {}); // never settles: the run must not wait for it
  });
});

describe('runSynthesis push trigger', () => {
  it('enqueues ready only after syncLinks, with the ready row (its updatedAt) and the course', async () => {
    await runSynthesis('p-1', 'n-1');
    expect(h.calls).toEqual(['updateNote:ready', 'syncLinks', 'notify:ready']);
    expect(notify).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({ id: 'n-1', updatedAt: readyAt }),
      'ready',
    );
  });

  it('a syncLinks failure sends failed, never ready', async () => {
    vi.mocked(syncLinks).mockRejectedValueOnce(new Error('links'));
    await runSynthesis('p-1', 'n-1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('p-1', expect.objectContaining({ updatedAt: failedAt }), 'failed');
  });

  it('a model failure enqueues failed inside fail()', async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error('timeout'));
    await runSynthesis('p-1', 'n-1');
    expect(h.calls).toEqual(['updateNote:failed', 'notify:failed']);
  });

  it('a missing raw note fails and enqueues failed', async () => {
    h.state.dbRows = [];
    await runSynthesis('p-1', 'n-1');
    expect(h.calls).toEqual(['updateNote:failed', 'notify:failed']);
  });

  it('sends nothing when the target note is gone (fail() found no row)', async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error('timeout'));
    vi.mocked(updateNote).mockResolvedValueOnce(undefined);
    await runSynthesis('p-1', 'n-1');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('failStaleGenerating', () => {
  it('marks stale notes failed at boot and sends nothing', async () => {
    h.state.dbRows = [{ id: 'n-1' }, { id: 'n-2' }];
    expect(await failStaleGenerating(20)).toBe(2);
    expect(notify).not.toHaveBeenCalled();
  });
});
