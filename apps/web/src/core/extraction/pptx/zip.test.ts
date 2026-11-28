// @vitest-environment node
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipBytes } from '@/lib/testing/tiny-pptx';
import { PptxError } from './errors';
import { readZip, type ZipLimits } from './zip';

const enc = new TextEncoder();
const allPpt = (n: string) => n.startsWith('ppt/');
const limits = (o: Partial<ZipLimits>): ZipLimits => ({
  maxEntryBytes: 1e9,
  maxTotalBytes: 1e9,
  maxEntries: 1e6,
  maxRatio: 1e9,
  ratioMinBytes: 1e9,
  ...o,
});
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PptxError);
    return (e as PptxError).code;
  }
  return undefined;
};
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const setU32 = (b: Uint8Array, at: number, v: number) => dv(b).setUint32(at, v, true);
const setU16 = (b: Uint8Array, at: number, v: number) => dv(b).setUint16(at, v, true);
/** Offsets of every central-directory record (signature 0x02014b50). */
const centralRecords = (b: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 4 <= b.length; i++) if (dv(b).getUint32(i, true) === 0x02014b50) out.push(i);
  return out;
};

// --- Hand-built archives, for shapes zipBytes never produces ---------------------------------------------
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const record = (size: number, fill: (v: DataView) => void): Uint8Array => {
  const b = new Uint8Array(size);
  fill(dv(b));
  return b;
};
/** A local header + name + body. */
const localRecord = (name: string, method: number, body: Uint8Array, original: number): Uint8Array =>
  concat(
    record(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(8, method, true);
      v.setUint32(18, body.length, true);
      v.setUint32(22, original, true);
      v.setUint16(26, enc.encode(name).length, true);
    }),
    enc.encode(name),
    body,
  );
const centralRecord = (
  name: string,
  method: number,
  csize: number,
  original: number,
  local: number,
): Uint8Array =>
  concat(
    record(46, (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(10, method, true);
      v.setUint32(20, csize, true);
      v.setUint32(24, original, true);
      v.setUint16(28, enc.encode(name).length, true);
      v.setUint32(42, local, true);
    }),
    enc.encode(name),
  );
const eocd = (count: number, cdSize: number, cdOffset: number): Uint8Array =>
  record(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Math.min(count, 0xffff), true);
    v.setUint16(10, Math.min(count, 0xffff), true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdOffset, true);
  });

/** Entry A's data embeds a complete local record for entry B, so B's byte range lies inside A's. */
function overlapping(method: 0 | 8): Uint8Array {
  const bBody = enc.encode('B body');
  const bLocal = localRecord('ppt/b.xml', 0, bBody, bBody.length);
  const aData = concat(enc.encode('0123456789'), bLocal);
  const aBody = method === 0 ? aData : deflateRawSync(aData, { level: 0 }); // stored blocks keep bytes verbatim
  const aLocal = localRecord('ppt/a.xml', method, aBody, aData.length);
  let bAt = -1;
  for (let i = 0; i + bLocal.length <= aLocal.length; i++) {
    if (aLocal.subarray(i, i + bLocal.length).every((b, j) => b === bLocal[j])) bAt = i;
  }
  const cd = concat(
    centralRecord('ppt/a.xml', method, aBody.length, aData.length, 0),
    centralRecord('ppt/b.xml', 0, bBody.length, bBody.length, bAt),
  );
  return concat(aLocal, cd, eocd(2, cd.length, aLocal.length));
}

/** Zip64 end records claiming `count` entries, behind a plain (empty) central directory. */
function zip64Count(count: bigint): Uint8Array {
  const z64At = 0;
  const z64 = record(56, (v) => {
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setBigUint64(24, count, true);
    v.setBigUint64(32, count, true);
  });
  // Entry-count fields are at +32 (total) in a real record; write both spots the reader may use.
  dv(z64).setBigUint64(32, count, true);
  const locator = record(20, (v) => {
    v.setUint32(0, 0x07064b50, true);
    v.setBigUint64(8, BigInt(z64At), true);
    v.setUint32(16, 1, true);
  });
  const end = record(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, 0xffff, true);
    v.setUint16(10, 0xffff, true);
    v.setUint32(12, 0xffffffff, true);
    v.setUint32(16, 0xffffffff, true);
  });
  return concat(z64, locator, end);
}

describe('readZip', () => {
  it('Z1 returns only wanted entries with their bytes', () => {
    const z = zipBytes({ 'ppt/a.xml': 'AAA', 'ppt/b.xml': 'BBB', 'docProps/c.xml': 'CCC' });
    const m = readZip(z, allPpt);
    expect([...m.keys()].sort()).toEqual(['ppt/a.xml', 'ppt/b.xml']);
    expect(new TextDecoder().decode(m.get('ppt/b.xml'))).toBe('BBB');
    const stored = readZip(zipBytes({ 'ppt/a.xml': 'AAA' }, { store: true }), allPpt);
    expect(new TextDecoder().decode(stored.get('ppt/a.xml'))).toBe('AAA');
  });

  it('Z2 never inflates unwanted entries, whatever their declared size', () => {
    const z = zipBytes({ 'ppt/a.xml': 'AAA', 'ppt/media/image1.png': new Uint8Array(50_000).fill(7) });
    const m = readZip(z, (n) => n.endsWith('.xml'), limits({ maxEntryBytes: 1000 }));
    expect([...m.keys()]).toEqual(['ppt/a.xml']);
  });

  it('Z3 caps one wanted entry and names it', () => {
    const z = zipBytes({ 'ppt/big.xml': 'x'.repeat(2000) });
    expect(() => readZip(z, allPpt, limits({ maxEntryBytes: 1000 }))).toThrow(/ppt\/big\.xml/);
    expect(codeOf(() => readZip(z, allPpt, limits({ maxEntryBytes: 1000 })))).toBe('zip_limits');
  });

  it('Z4 caps the total of wanted entries', () => {
    const z = zipBytes({ 'ppt/a.xml': 'a'.repeat(600), 'ppt/b.xml': 'b'.repeat(600) });
    expect(codeOf(() => readZip(z, allPpt, limits({ maxTotalBytes: 1000 })))).toBe('zip_limits');
  });

  it('Z5 caps the entry count, unwanted entries included', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 11; i++) files[`other/f${i}.bin`] = 'x';
    expect(codeOf(() => readZip(zipBytes(files), allPpt, limits({ maxEntries: 10 })))).toBe('zip_limits');
  });

  it('Z6 rejects a real compression-ratio bomb', () => {
    const z = zipBytes({ 'ppt/bomb.xml': new Uint8Array(5 * 1024 * 1024).fill(0x41) }, { level: 9 });
    expect(codeOf(() => readZip(z, allPpt, limits({ maxRatio: 200, ratioMinBytes: 1024 * 1024 })))).toBe(
      'zip_limits',
    );
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_limits'); // default entry cap trips first
  });

  it('Z7 accepts a highly compressible entry under the ratio floor', () => {
    const z = zipBytes({ 'ppt/a.xml': new Uint8Array(900 * 1024).fill(0x41) }, { level: 9 });
    expect(readZip(z, allPpt).get('ppt/a.xml')?.length).toBe(900 * 1024);
  });

  it('Z8 refuses a directory that lies about the size, stored or deflated', () => {
    for (const store of [true, false]) {
      const z = zipBytes({ 'ppt/a.xml': 'x'.repeat(5000) }, { store });
      const rec = centralRecords(z)[0] ?? 0;
      setU32(z, rec + 24, 10); // uncompressed size in the central directory
      expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
    }
  });

  it('Z9 rejects a duplicate wanted name', () => {
    const z = zipBytes({ 'ppt/slide1.xml': 'one', 'ppt/slide2.xml': 'two' });
    const needle = enc.encode('slide2.xml');
    const repl = enc.encode('slide1.xml');
    for (let i = 0; i + needle.length <= z.length; i++) {
      if (needle.every((b, j) => z[i + j] === b)) z.set(repl, i);
    }
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
  });

  it('Z10 ignores odd entry names without error', () => {
    const z = zipBytes({
      '../x.xml': 'a',
      '/ppt/a.xml': 'b',
      'ppt\\a.xml': 'c',
      'ppt/./a.xml': 'd',
      'ppt/dir/': '',
      'ppt/ok.xml': 'e',
    });
    const m = readZip(z, () => true);
    expect([...m.keys()]).toEqual(['ppt/ok.xml']);
  });

  it('Z11 turns non-zip input into typed errors', () => {
    expect(codeOf(() => readZip(enc.encode('%PDF-1.7\n'.repeat(5)), allPpt))).toBe('not_zip');
    const cfb = new Uint8Array(64);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(codeOf(() => readZip(cfb, allPpt))).toBe('encrypted');
    expect(codeOf(() => readZip(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), allPpt))).toBe('not_zip');
    const z = zipBytes({ 'ppt/a.xml': 'hello world hello world' });
    const rec = centralRecords(z)[0] ?? 0;
    setU16(z, rec + 10, 99); // compression method in the central directory
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
    const good = zipBytes({ 'ppt/a.xml': 'hello' });
    expect(codeOf(() => readZip(good.slice(0, good.length - 10), allPpt))).toBe('not_zip');
  });

  it('Z12 rejects stored entries whose byte ranges overlap', () => {
    expect(codeOf(() => readZip(overlapping(0), allPpt))).toBe('zip_entry');
  });

  it('Z13 rejects deflated entries whose byte ranges overlap', () => {
    expect(codeOf(() => readZip(overlapping(8), allPpt))).toBe('zip_entry');
  });

  it('Z14 stops inflating at the declared size when the directory lies low', () => {
    const body = deflateRawSync(new Uint8Array(100 * 1024 * 1024));
    const local = localRecord('ppt/a.xml', 8, body, 100);
    const cd = centralRecord('ppt/a.xml', 8, body.length, 100, 0);
    const z = concat(local, cd, eocd(1, cd.length, local.length));
    const t0 = performance.now();
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
    expect(performance.now() - t0).toBeLessThan(250); // the real stream is 100 MB of output
  });

  it('Z15 fails fast on a zip64 entry count above the cap', () => {
    const t0 = performance.now();
    expect(codeOf(() => readZip(zip64Count(4_000_000_000n), allPpt))).toBe('zip_limits');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
