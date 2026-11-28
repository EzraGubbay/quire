// @vitest-environment node
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PptxError } from './errors';
import { readZip, type ZipLimits } from './zip';

const mtime = new Date(1980, 0, 1);
const zip = (files: Record<string, Uint8Array | string>, level: 0 | 6 | 9 = 6): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, [typeof v === 'string' ? strToU8(v) : v, { level, mtime }]]),
    ),
  );
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
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const setU32 = (b: Uint8Array, at: number, v: number) =>
  new DataView(b.buffer, b.byteOffset).setUint32(at, v, true);
const setU16 = (b: Uint8Array, at: number, v: number) =>
  new DataView(b.buffer, b.byteOffset).setUint16(at, v, true);
/** Offsets of every central-directory record (signature 0x02014b50). */
const centralRecords = (b: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 4 <= b.length; i++) if (u32(b, i) === 0x02014b50) out.push(i);
  return out;
};

describe('readZip', () => {
  it('Z1 returns only wanted entries with their bytes', () => {
    const z = zip({ 'ppt/a.xml': 'AAA', 'ppt/b.xml': 'BBB', 'docProps/c.xml': 'CCC' });
    const m = readZip(z, allPpt);
    expect([...m.keys()].sort()).toEqual(['ppt/a.xml', 'ppt/b.xml']);
    expect(new TextDecoder().decode(m.get('ppt/b.xml'))).toBe('BBB');
  });

  it('Z2 never inflates unwanted entries, whatever their declared size', () => {
    const z = zip({ 'ppt/a.xml': 'AAA', 'ppt/media/image1.png': new Uint8Array(50_000).fill(7) });
    const m = readZip(z, (n) => n.endsWith('.xml'), limits({ maxEntryBytes: 1000 }));
    expect([...m.keys()]).toEqual(['ppt/a.xml']);
  });

  it('Z3 caps one wanted entry and names it', () => {
    const z = zip({ 'ppt/big.xml': 'x'.repeat(2000) });
    expect(() => readZip(z, allPpt, limits({ maxEntryBytes: 1000 }))).toThrow(/ppt\/big\.xml/);
    expect(codeOf(() => readZip(z, allPpt, limits({ maxEntryBytes: 1000 })))).toBe('zip_limits');
  });

  it('Z4 caps the total of wanted entries', () => {
    const z = zip({ 'ppt/a.xml': 'a'.repeat(600), 'ppt/b.xml': 'b'.repeat(600) });
    expect(codeOf(() => readZip(z, allPpt, limits({ maxTotalBytes: 1000 })))).toBe('zip_limits');
  });

  it('Z5 caps the entry count, unwanted entries included', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 11; i++) files[`other/f${i}.bin`] = 'x';
    expect(codeOf(() => readZip(zip(files), allPpt, limits({ maxEntries: 10 })))).toBe('zip_limits');
  });

  it('Z6 rejects a real compression-ratio bomb under default limits', () => {
    const z = zip({ 'ppt/bomb.xml': new Uint8Array(5 * 1024 * 1024).fill(0x41) }, 9);
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_limits');
  });

  it('Z7 accepts a highly compressible entry under the ratio floor', () => {
    const z = zip({ 'ppt/a.xml': new Uint8Array(900 * 1024).fill(0x41) }, 9);
    expect(readZip(z, allPpt).get('ppt/a.xml')?.length).toBe(900 * 1024);
  });

  it('Z8 never returns more than the declared size when the directory lies low', () => {
    const z = zip({ 'ppt/a.xml': 'x'.repeat(5000) }, 9);
    const rec = centralRecords(z)[0] ?? 0;
    setU32(z, rec + 24, 10); // uncompressed size in the central directory
    let got: Uint8Array | undefined;
    try {
      got = readZip(z, allPpt).get('ppt/a.xml');
    } catch (e) {
      expect(e).toBeInstanceOf(PptxError);
    }
    if (got) expect(got.length).toBeLessThanOrEqual(10);
  });

  it('Z9 rejects a duplicate wanted name', () => {
    const z = zip({ 'ppt/slide1.xml': 'one', 'ppt/slide2.xml': 'two' }, 9);
    const needle = strToU8('slide2.xml');
    const repl = strToU8('slide1.xml');
    for (let i = 0; i + needle.length <= z.length; i++) {
      if (needle.every((b, j) => z[i + j] === b)) z.set(repl, i);
    }
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
  });

  it('Z10 ignores odd entry names without error', () => {
    const z = zip({
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
    expect(codeOf(() => readZip(strToU8('%PDF-1.7\n'.repeat(5)), allPpt))).toBe('not_zip');
    const cfb = new Uint8Array(64);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(codeOf(() => readZip(cfb, allPpt))).toBe('encrypted');
    expect(codeOf(() => readZip(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), allPpt))).toBe('not_zip');
    const z = zip({ 'ppt/a.xml': 'hello world hello world' }, 9);
    const rec = centralRecords(z)[0] ?? 0;
    setU16(z, rec + 10, 99); // compression method in the central directory
    expect(codeOf(() => readZip(z, allPpt))).toBe('zip_entry');
  });
});
