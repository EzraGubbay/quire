// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSmokeCases } from '../../../scripts/render-smoke/smoke-pdfs.mjs';
import { openPdf, pdfAssetUrls, pdfjsOptions } from './open';

const tmp = mkdtempSync(path.join(tmpdir(), 'pdf-open-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name: string, dirs: string[]): string {
  const cwd = path.join(tmp, name);
  for (const d of dirs) mkdirSync(path.join(cwd, d), { recursive: true });
  return cwd;
}

describe('pdfAssetUrls', () => {
  it('prefers public/pdfjs over the package copy', () => {
    const cwd = tree('both', ['public/pdfjs/standard_fonts', 'node_modules/pdfjs-dist/standard_fonts']);
    expect(pdfAssetUrls(cwd).standardFontDataUrl).toBe(`${path.join(cwd, 'public/pdfjs/standard_fonts')}/`);
  });

  it('resolves each asset on its own: a public dir missing wasm falls back to the package', () => {
    const cwd = tree('stale', ['public/pdfjs/standard_fonts', 'node_modules/pdfjs-dist/wasm']);
    const urls = pdfAssetUrls(cwd);
    expect(urls.standardFontDataUrl).toContain(path.join('public', 'pdfjs'));
    expect(urls.wasmUrl).toContain(path.join('node_modules', 'pdfjs-dist', 'wasm'));
  });

  it('finds the apps/web layout from the repo root', () => {
    const cwd = tree('root', ['apps/web/public/pdfjs/cmaps']);
    expect(pdfAssetUrls(cwd).cMapUrl).toBe(`${path.join(cwd, 'apps/web/public/pdfjs/cmaps')}/`);
  });

  it('omits keys with no directory anywhere', () => {
    expect(pdfAssetUrls(tree('none', []))).toEqual({});
  });

  it('resolves all four from the real app dir, each ending in a slash', () => {
    const urls = pdfAssetUrls();
    expect(Object.keys(urls).sort()).toEqual(['cMapUrl', 'iccUrl', 'standardFontDataUrl', 'wasmUrl']);
    for (const v of Object.values(urls)) expect(v.endsWith('/')).toBe(true);
  });
});

describe('pdfjsOptions', () => {
  it('turns system fonts off, packs CMaps and spreads the assets', () => {
    const opts = pdfjsOptions(new Uint8Array([1]), { wasmUrl: '/w/' });
    expect(opts.useSystemFonts).toBe(false);
    expect(opts.cMapPacked).toBe(true);
    expect(opts.wasmUrl).toBe('/w/');
  });

  it('hands pdf.js a copy of the data', () => {
    const input = new Uint8Array([1, 2, 3]);
    const opts = pdfjsOptions(input, {});
    input[0] = 9;
    expect(opts.data[0]).toBe(1);
  });

  it('includes CanvasFactory only when given', () => {
    expect('CanvasFactory' in pdfjsOptions(new Uint8Array(1), {})).toBe(false);
    class F {}
    expect(pdfjsOptions(new Uint8Array(1), {}, F).CanvasFactory).toBe(F);
  });
});

describe('openPdf', () => {
  it('opens a synthetic PDF and reads its text', async () => {
    const { cases } = buildSmokeCases({ fontDir: pdfAssetUrls().standardFontDataUrl });
    const c = cases.find((x: { id: string }) => x.id === 'text-helvetica');
    const doc = await openPdf(c?.bytes as Uint8Array);
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
    expect(text).toContain('Render smoke text');
    await doc.destroy();
  });
});
