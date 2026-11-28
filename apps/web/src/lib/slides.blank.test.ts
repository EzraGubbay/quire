// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawPdf } from './testing/raw-pdf';

// The blank-render guard: a page that paints but renders flat is never cached and is reported through onBlank.
const tmp = mkdtempSync(path.join(tmpdir(), 'slides-blank-'));
process.env.FILES_DIR = tmp;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('renderPages blank guard', () => {
  let renderPages: typeof import('./slides').renderPages;
  beforeAll(async () => {
    ({ renderPages } = await import('./slides'));
  });

  async function docFor(id: string, content: string) {
    await mkdir(path.join(tmp, id), { recursive: true });
    await writeFile(path.join(tmp, id, `${id}.pdf`), rawPdf(content));
    return { projectId: id, id, filePath: path.join(id, `${id}.pdf`) };
  }
  const opts = { cacheName: 'blank-test', maxWidth: 1024, maxHeight: 1568, quality: 60, maxBytes: 72_000 };

  it('reports a white-filled page as blank and does not cache it', async () => {
    const doc = await docFor('white-rect', '1 g 0 0 720 405 re f');
    const blanks: number[] = [];
    const first = await renderPages(doc, [1], { ...opts, onBlank: (n) => blanks.push(n) });
    expect(first).toEqual([]);
    expect(blanks).toEqual([1]);
    const dir = await readdir(path.join(tmp, doc.projectId, `${doc.id}.blank-test`));
    expect(dir).not.toContain('1.jpg');
    await renderPages(doc, [1], { ...opts, onBlank: (n) => blanks.push(n) });
    expect(blanks).toEqual([1, 1]);
  });

  it('caches a page that paints nothing (legitimately empty)', async () => {
    const doc = await docFor('empty', '');
    const blanks: number[] = [];
    const imgs = await renderPages(doc, [1], { ...opts, onBlank: (n) => blanks.push(n) });
    expect(imgs).toHaveLength(1);
    expect(blanks).toEqual([]);
  });

  it('keeps a page with only a small page number (not flat)', async () => {
    const doc = await docFor('page-number', 'BT /F1 10 Tf 690 20 Td (3) Tj ET');
    const blanks: number[] = [];
    const imgs = await renderPages(doc, [1], { ...opts, onBlank: (n) => blanks.push(n) });
    expect(imgs).toHaveLength(1);
    expect(blanks).toEqual([]);
  });
});

describe('isFlat', () => {
  let isFlat: typeof import('./slides').isFlat;
  beforeAll(async () => {
    ({ isFlat } = await import('./slides'));
  });
  const px = (...rgb: number[][]) => Uint8ClampedArray.from(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));
  it('is true for one colour', () => {
    expect(isFlat(px([255, 255, 255], [255, 255, 255]))).toBe(true);
    expect(isFlat(px([10, 20, 200], [10, 20, 200]))).toBe(true);
  });
  it('is false when one pixel is 7 levels off in a channel', () => {
    expect(isFlat(px([255, 255, 255], [255, 248, 255]))).toBe(false);
  });
  it('tolerates a difference of 6', () => {
    expect(isFlat(px([255, 255, 255], [255, 249, 255]))).toBe(true);
  });
});
