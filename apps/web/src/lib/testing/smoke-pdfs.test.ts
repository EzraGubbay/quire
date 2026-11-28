import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSmokeCases, JPEG_BASE64 } from '../../../scripts/render-smoke/smoke-pdfs.mjs';

// Parse-only: rendering is deliberately not exercised here (that is the runtime-image smoke's job).
const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = (): Promise<Pdfjs> => import('pdfjs-dist/legacy/build/pdf.mjs');

async function opsOf(bytes: Uint8Array) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  try {
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    expect(page.view).toEqual([0, 0, 720, 405]);
    const list = await page.getOperatorList();
    const names = new Map(Object.entries(lib.OPS).map(([k, v]) => [v as number, k]));
    return { page, ops: new Set(list.fnArray.map((f) => names.get(f))) };
  } finally {
    await doc.destroy();
  }
}

const EXPECTED: Record<string, string[][]> = {
  'text-type3': [['showText']],
  'text-helvetica': [['showText']],
  'text-embedded-truetype': [['showText']],
  'vector-shapes': [['constructPath']],
  'shading-axial': [['shadingFill']],
  'image-raw-gray': [['paintImageXObject']],
  'image-jpeg': [['paintImageXObject']],
  'image-smask': [['paintImageXObject']],
  'image-stencil-mask': [['paintImageMaskXObject', 'paintSolidColorImageMask']],
  'transparency-group': [['beginGroup']],
  'slide-combo': [['showText'], ['constructPath'], ['paintImageXObject']],
};

describe('smoke PDFs', () => {
  const { cases, skipped } = buildSmokeCases({ fontDir });

  it('builds every case when the font directory is given', () => {
    expect(skipped).toEqual([]);
    expect(cases.map((c) => c.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('is byte-for-byte deterministic', () => {
    const again = buildSmokeCases({ fontDir }).cases;
    for (const c of cases) {
      expect(Buffer.compare(c.bytes, again.find((a) => a.id === c.id)?.bytes ?? Buffer.alloc(0))).toBe(0);
    }
  });

  it.each(Object.keys(EXPECTED))('%s parses as one 720x405 page with its feature operator', async (id) => {
    const c = cases.find((x) => x.id === id);
    expect(c).toBeDefined();
    const { ops } = await opsOf(c?.bytes as Uint8Array);
    for (const anyOf of EXPECTED[id] ?? []) {
      expect(anyOf.some((op) => ops.has(op))).toBe(true);
    }
  });

  it('text-helvetica carries its words', async () => {
    const c = cases.find((x) => x.id === 'text-helvetica');
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(c?.bytes as Uint8Array) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ');
    await doc.destroy();
    expect(text).toContain('Render smoke text');
    expect(text).toContain('Third line goes here');
  });

  it('every region sits on the page and has a positive threshold', () => {
    for (const c of cases) {
      expect(c.regions.length).toBeGreaterThan(0);
      for (const r of c.regions) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(720);
        expect(r.y + r.h).toBeLessThanOrEqual(405);
        expect(r.min).toBeGreaterThan(0);
      }
    }
  });

  it('skips the embedded-font case without a font directory', () => {
    const none = buildSmokeCases();
    expect(none.skipped.map((s) => s.id)).toEqual(['text-embedded-truetype']);
    expect(none.cases.some((c) => c.id === 'text-embedded-truetype')).toBe(false);
  });

  it('the JPEG constant is a 96x64 baseline 3-component JPEG', () => {
    const b = Buffer.from(JPEG_BASE64, 'base64');
    expect(b.subarray(0, 2).toString('hex')).toBe('ffd8');
    const sof = b.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    expect(b.readUInt16BE(sof + 5)).toBe(64); // height
    expect(b.readUInt16BE(sof + 7)).toBe(96); // width
    expect(b[sof + 9]).toBe(3); // components
  });
});
