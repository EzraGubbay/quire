import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __storeForTests,
  claimLink,
  createLink,
  getStatus as getStatusIn,
  type LinkBinding,
  peekLink,
  setClock,
  setStatus,
  TOKEN_RE,
} from './upload-links';

const binding: LinkBinding = {
  projectId: 'p1',
  scope: 'course',
  section: 'documents',
  kind: 'pdf',
  filename: 'a.pdf',
  folderId: null,
  folderName: null,
  contentType: 'application/pdf',
  maxBytes: 100,
};
// The scope is an explicit, required argument; these tests exercise the course scope.
const getStatus = (id: string) => getStatusIn(id, 'course');
let t = 1_000_000;
beforeEach(() => {
  t = 1_000_000;
  setClock(() => t);
  const s = __storeForTests();
  s.links.clear();
  s.statuses.clear();
});
afterEach(() => {
  setClock(null);
  delete process.env.MCP_UPLOAD_LINK_MAX_OPEN;
});

describe('upload link store', () => {
  it('mints 43-char base64url tokens, unique across 1000 mints', () => {
    process.env.MCP_UPLOAD_LINK_MAX_OPEN = '5000';
    const tokens = new Set(Array.from({ length: 1000 }, () => createLink(binding).token));
    expect(tokens.size).toBe(1000);
    for (const tok of tokens) expect(tok).toMatch(TOKEN_RE);
  });

  it('never stores the raw token', () => {
    const { token } = createLink(binding);
    const s = __storeForTests();
    expect(JSON.stringify([...s.links.entries(), ...s.statuses.entries()])).not.toContain(token);
  });

  it('peek does not consume; claim succeeds once (replay returns null)', () => {
    const { token } = createLink(binding);
    expect(peekLink(token)).not.toBeNull();
    expect(peekLink(token)).not.toBeNull();
    expect(claimLink(token)?.projectId).toBe('p1');
    expect(claimLink(token)).toBeNull();
    expect(peekLink(token)).toBeNull();
  });

  it('two concurrent claims give exactly one winner', async () => {
    const { token } = createLink(binding);
    const results = await Promise.all([
      Promise.resolve().then(() => claimLink(token)),
      Promise.resolve().then(() => claimLink(token)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('expires after the TTL and marks the status expired', () => {
    const { token, uploadId } = createLink(binding);
    t += 10 * 60 * 1000 + 1;
    expect(peekLink(token)).toBeNull();
    expect(claimLink(token)).toBeNull();
    expect(getStatus(uploadId)?.state).toBe('expired');
  });

  it('caps open links', () => {
    process.env.MCP_UPLOAD_LINK_MAX_OPEN = '2';
    createLink(binding);
    createLink(binding);
    expect(() => createLink(binding)).toThrow(/Too many open/);
  });

  it('status lifecycle, 24 h eviction and the count cap', () => {
    const { uploadId } = createLink(binding);
    expect(getStatus(uploadId)?.state).toBe('pending');
    setStatus(uploadId, { state: 'processing' });
    setStatus(uploadId, { state: 'created', result: { fileId: 'f' } });
    expect(getStatus(uploadId)).toMatchObject({ state: 'created', result: { fileId: 'f' } });
    t += 24 * 3600 * 1000 + 1;
    expect(getStatus(uploadId)).toBeUndefined();
    // setStatus never creates statuses (only createLink does), so seed real rows to exercise the count cap.
    const { statuses } = __storeForTests();
    for (let i = 0; i < 520; i++) {
      statuses.set(`u${i}`, { uploadId: `u${i}`, scope: 'course', state: 'created', updatedAt: t + i });
    }
    expect(statuses.size).toBeGreaterThan(500);
    getStatus('x');
    expect(__storeForTests().statuses.size).toBeLessThanOrEqual(500);
    expect(getStatus('u0')).toBeUndefined();
  });

  it('is shared between module instances through globalThis', async () => {
    setClock(null); // the re-imported module has its own clock
    const { token } = createLink(binding);
    vi.resetModules();
    const other = await import('./upload-links');
    expect(other.peekLink(token)).not.toBeNull();
  });
});
