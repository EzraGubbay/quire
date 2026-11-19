import { describe, expect, it } from 'vitest';
import { buildPairingUri, shapeDevices } from './pairing-ui';

describe('buildPairingUri', () => {
  it('encodes server origin and code into the quire://pair URI', () => {
    expect(buildPairingUri('https://quire.example.com', 'ABCD2345')).toBe(
      'quire://pair?server=https%3A%2F%2Fquire.example.com&code=ABCD2345',
    );
  });
  it('strips a trailing slash from the origin and encodes the code', () => {
    expect(buildPairingUri('http://192.168.1.5:3000/', 'A B')).toBe(
      'quire://pair?server=http%3A%2F%2F192.168.1.5%3A3000&code=A%20B',
    );
  });
});

describe('shapeDevices', () => {
  const t = (s: string) => new Date(s);
  it('drops revoked tokens, orders newest first, and exposes only safe fields', () => {
    const rows = [
      {
        id: 'a',
        deviceName: 'Old',
        createdAt: t('2026-01-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
        tokenHash: 'x',
      },
      {
        id: 'b',
        deviceName: 'Gone',
        createdAt: t('2026-03-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: t('2026-03-02T00:00:00Z'),
        tokenHash: 'y',
      },
      {
        id: 'c',
        deviceName: 'New',
        createdAt: t('2026-02-01T00:00:00Z'),
        lastUsedAt: t('2026-02-05T00:00:00Z'),
        revokedAt: null,
        tokenHash: 'z',
      },
    ];
    expect(shapeDevices(rows)).toEqual([
      { id: 'c', name: 'New', createdAt: '2026-02-01T00:00:00.000Z', lastUsedAt: '2026-02-05T00:00:00.000Z' },
      { id: 'a', name: 'Old', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null },
    ]);
  });
});
