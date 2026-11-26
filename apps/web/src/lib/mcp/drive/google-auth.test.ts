import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildServiceJwt, DRIVE_READONLY_SCOPE, DriveError, serviceTokenSource } from './google-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const cfg = { clientEmail: 'sa@p.iam.gserviceaccount.com', privateKey: pem };
const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('buildServiceJwt', () => {
  const jwt = buildServiceJwt(cfg, DRIVE_READONLY_SCOPE, 1000);
  const [h, c, s] = jwt.split('.') as [string, string, string];

  it('has the RS256 header and the expected claims', () => {
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(dec(c)).toEqual({
      iss: cfg.clientEmail,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1000,
      exp: 4600,
    });
  });

  it('carries a signature that verifies, and fails when tampered with', () => {
    const ok = (input: string, sig: string) =>
      verify('RSA-SHA256', Buffer.from(input), publicKey, Buffer.from(sig, 'base64url'));
    expect(ok(`${h}.${c}`, s)).toBe(true);
    const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(ok(`${h}.${c}`, flipped)).toBe(false);
    expect(ok(`${h}.${c}x`, s)).toBe(false);
  });
});

const tokenRes = (token = 'tok', expires_in = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in }));

describe('serviceTokenSource', () => {
  it('posts the form-encoded jwt-bearer grant', async () => {
    const fetch = vi.fn(async () => tokenRes());
    await serviceTokenSource(cfg, { fetch, now: () => 5_000_000 }).getToken();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')?.split('.')).toHaveLength(3);
  });

  it('caches until expires_in minus 5 minutes, then refreshes; clear() forces a refresh', async () => {
    let t = 1_000_000;
    const fetch = vi.fn(async () => tokenRes(`t${fetch.mock.calls.length}`, 3600));
    const src = serviceTokenSource(cfg, { fetch, now: () => t });
    expect(await src.getToken()).toBe('t1');
    t += 3600_000 - 5 * 60_000 - 1;
    expect(await src.getToken()).toBe('t1');
    t += 2;
    expect(await src.getToken()).toBe('t2');
    src.clear();
    expect(await src.getToken()).toBe('t3');
  });

  it.each([
    [400, 'AUTH_REJECTED'],
    [401, 'AUTH_REJECTED'],
    [429, 'UNAVAILABLE'],
    [500, 'UNAVAILABLE'],
  ])('maps oauth %i to %s', async (status, code) => {
    const src = serviceTokenSource(cfg, {
      fetch: async () => new Response('{"error":"secret-body"}', { status }),
    });
    await expect(src.getToken()).rejects.toMatchObject({ code });
  });

  it('maps a thrown fetch to NETWORK and a TimeoutError to TIMEOUT, without leaking the assertion or token', async () => {
    const net = serviceTokenSource(cfg, {
      fetch: async () => {
        throw new TypeError('connect ECONNREFUSED with assertion eyJ...');
      },
    });
    const e1 = await net.getToken().catch((e) => e);
    expect(e1).toBeInstanceOf(DriveError);
    expect(e1.code).toBe('NETWORK');
    expect(e1.message).not.toMatch(/eyJ|ECONNREFUSED/);
    const to = serviceTokenSource(cfg, {
      fetch: async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    });
    await expect(to.getToken()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects an unusable key without echoing it', async () => {
    const src = serviceTokenSource({ clientEmail: 'a', privateKey: 'NOT-A-KEY' }, { fetch: vi.fn() });
    const e = await src.getToken().catch((x) => x);
    expect(e.code).toBe('AUTH_REJECTED');
    expect(e.message).not.toContain('NOT-A-KEY');
  });
});
