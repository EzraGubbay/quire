// @vitest-environment node
// enqueueCommand's coalescing UPDATE must not drop a payload when the engine claims the pending row between
// the SELECT and the UPDATE: it falls through to a fresh INSERT. (Simulated with a scripted fake db.)
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const inserted: unknown[] = [];
  // Every builder method returns the chain; awaiting it pops the next scripted result.
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set', 'returning', 'orderBy', 'for']) {
    chain[m] = () => chain;
  }
  chain.values = (v: unknown) => {
    inserted.push(v);
    return chain;
  };
  // Deliberately thenable: awaiting any builder pops the next scripted result.
  Object.defineProperty(chain, 'then', {
    value: (res: (v: unknown) => unknown) => res(queue.shift()),
  });
  const fake = {
    ...chain,
    insert: () => chain,
    transaction: async (cb: (tx: unknown) => unknown) => cb(chain),
  };
  return { queue, inserted, fake };
});
vi.mock('@/db/client', () => ({ db: h.fake }));
vi.mock('./courses', () => ({ enabledMappings: vi.fn(async () => []) }));

const { enqueueCommand } = await import('./commands');

describe('enqueueCommand coalescing race', () => {
  it('inserts a new row (keeping the payload) when the pending row was claimed before the UPDATE', async () => {
    const existing = { id: 'old', kind: 'sync', status: 'pending', payload: {} };
    const fresh = { id: 'new', kind: 'sync', status: 'pending', payload: { full: true } };
    // reap: lost update, running select, expired update; then select existing; guarded update hits 0 rows; insert.
    h.queue.push([], [], [], [existing], [], [fresh]);
    const row = await enqueueCommand('sync', { full: true }, new Date('2026-11-24T12:00:00Z'));
    expect(row).toBe(fresh);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({ kind: 'sync', payload: { full: true } });
  });
});
