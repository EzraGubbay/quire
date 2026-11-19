import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AuthStore,
  authenticate,
  createPairingCode,
  exchangePairingCode,
  hashSecret,
  PAIRING_CODE_TTL_MS,
  revokeToken,
  type TokenRow,
} from './auth';

/** In-memory AuthStore; mirrors the atomic semantics of the SQL store. */
function memoryStore() {
  const codes = new Map<string, { ownerLogin: string; expiresAt: Date; usedAt: Date | null }>();
  const tokens: TokenRow[] = [];
  const store: AuthStore = {
    async insertCode(codeHash, ownerLogin, expiresAt) {
      codes.set(codeHash, { ownerLogin, expiresAt, usedAt: null });
    },
    async consumeCode(codeHash, now) {
      const c = codes.get(codeHash);
      if (!c || c.usedAt || c.expiresAt <= now) return null;
      c.usedAt = now;
      return c.ownerLogin;
    },
    async insertToken(row) {
      const full: TokenRow = {
        ...row,
        id: crypto.randomUUID(),
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.push(full);
      return full;
    },
    async findActiveByHash(tokenHash) {
      return tokens.find((t) => t.tokenHash === tokenHash && !t.revokedAt) ?? null;
    },
    async touch(id, now) {
      const t = tokens.find((x) => x.id === id);
      if (t) t.lastUsedAt = now;
    },
    async revoke(id, now) {
      const t = tokens.find((x) => x.id === id && !x.revokedAt);
      if (t) t.revokedAt = now;
    },
  };
  return { store, codes, tokens };
}

const req = (token?: string) =>
  new Request('http://x/api/mobile/v1/me', { headers: token ? { authorization: `Bearer ${token}` } : {} });

let m: ReturnType<typeof memoryStore>;
beforeEach(() => {
  m = memoryStore();
});

describe('hashSecret', () => {
  it('is a stable 64-char hex sha-256 and never the input', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashSecret('abc')).not.toContain('abc');
  });
});

describe('createPairingCode', () => {
  it('returns an 8-char alphanumeric code with a 10 minute expiry, storing only the hash', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { code, expiresAt } = await createPairingCode('alice', m.store, now);
    expect(code).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(expiresAt.getTime() - now.getTime()).toBe(PAIRING_CODE_TTL_MS);
    expect(PAIRING_CODE_TTL_MS).toBe(10 * 60 * 1000);
    expect([...m.codes.keys()]).toEqual([hashSecret(code)]);
    expect(m.codes.has(code)).toBe(false);
  });

  it('mints distinct codes', async () => {
    const a = await createPairingCode('alice', m.store);
    const b = await createPairingCode('alice', m.store);
    expect(a.code).not.toBe(b.code);
  });
});

describe('exchangePairingCode', () => {
  it('returns the raw token once; only its hash is stored; owner comes from the code', async () => {
    const { code } = await createPairingCode('alice', m.store);
    const r = await exchangePairingCode(code, 'Pixel', m.store);
    expect(r).not.toBeNull();
    expect(r?.token.length).toBeGreaterThanOrEqual(32);
    expect(r?.device.name).toBe('Pixel');
    expect(m.tokens).toHaveLength(1);
    expect(m.tokens[0]?.tokenHash).toBe(hashSecret(r?.token ?? ''));
    expect(m.tokens[0]?.ownerLogin).toBe('alice');
    expect(JSON.stringify(m.tokens)).not.toContain(r?.token);
  });

  it('rejects a replayed code', async () => {
    const { code } = await createPairingCode('alice', m.store);
    expect(await exchangePairingCode(code, 'a', m.store)).not.toBeNull();
    expect(await exchangePairingCode(code, 'b', m.store)).toBeNull();
    expect(m.tokens).toHaveLength(1);
  });

  it('rejects an expired code', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const { code } = await createPairingCode('alice', m.store, t0);
    const late = new Date(t0.getTime() + PAIRING_CODE_TTL_MS + 1);
    expect(await exchangePairingCode(code, 'a', m.store, late)).toBeNull();
  });

  it('rejects an unknown code', async () => {
    expect(await exchangePairingCode('AAAAAAAA', 'a', m.store)).toBeNull();
  });
});

describe('authenticate', () => {
  async function paired(owner = 'alice') {
    const { code } = await createPairingCode(owner, m.store);
    const r = await exchangePairingCode(code, 'Pixel', m.store);
    if (!r) throw new Error('pair failed');
    return r;
  }

  it('resolves a valid token to its principal and updates last_used_at', async () => {
    const { token, device } = await paired('bob');
    const now = new Date('2026-02-02T00:00:00Z');
    const p = await authenticate(req(token), m.store, now);
    expect(p).toMatchObject({ login: 'bob', tokenId: device.id, deviceName: 'Pixel' });
    expect(m.tokens[0]?.lastUsedAt).toEqual(now);
  });

  it('rejects missing, malformed, wrong and non-bearer credentials', async () => {
    await paired();
    expect(await authenticate(req(), m.store)).toBeNull();
    expect(await authenticate(req('nope'), m.store)).toBeNull();
    expect(
      await authenticate(new Request('http://x', { headers: { authorization: 'Basic abc' } }), m.store),
    ).toBeNull();
    expect(
      await authenticate(new Request('http://x', { headers: { authorization: 'Bearer ' } }), m.store),
    ).toBeNull();
    expect(m.tokens[0]?.lastUsedAt).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const { token, device } = await paired();
    await revokeToken(device.id, m.store);
    expect(await authenticate(req(token), m.store)).toBeNull();
    expect(m.tokens[0]?.revokedAt).not.toBeNull();
  });

  it('scopes identity per device owner', async () => {
    const a = await paired('alice');
    const b = await paired('bob');
    expect((await authenticate(req(a.token), m.store))?.login).toBe('alice');
    expect((await authenticate(req(b.token), m.store))?.login).toBe('bob');
  });
});
