import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The render smoke's `prod` variant (scripts/render-smoke/render-one.mjs) re-implements how lib/slides.ts,
// core/pdf/open.ts and lib/pdf-canvas.ts render a page. This tripwire pins every part of them the smoke mirrors, so the two get updated together. It compares
// whitespace-collapsed text, so formatting changes pass but any change to the mirrored logic fails.
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const slides = read('src/lib/slides.ts');
const open = read('src/core/pdf/open.ts');
const canvasSrc = read('src/lib/pdf-canvas.ts');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const HINT =
  'lib/slides.ts, core/pdf/open.ts or lib/pdf-canvas.ts changed how a page renders: update the prod variant in scripts/render-smoke/render-one.mjs';

/** The body of renderPageTo, from its signature to page.cleanup(). */
function renderPageToBody(): string {
  const start = slides.indexOf('async function renderPageTo(');
  const endMarker = "page.cleanup();\n  return 'written';\n}";
  const end = slides.indexOf(endMarker, start);
  expect(start, HINT).toBeGreaterThan(-1);
  expect(end, HINT).toBeGreaterThan(start);
  return collapse(slides.slice(start, end + endMarker.length));
}

// The blank guard in renderPageTo (isFlat check, retry at scale 1, the 'blank' result) is deliberately NOT mirrored
// in render-one.mjs: the smoke judges the first render, so a blank first render fails the smoke even when the
// retry would rescue it. Stricter by design. The pinned text below still contains the guard, so editing it
// trips this test and prompts a look at the harness.
const RENDER_PAGE_TO =
  "async function renderPageTo( pdf: PdfDoc, createCanvas: CreateCanvas, pageNo: number, target: string, maxWidth: number, quality: number, maxHeight?: number, maxBytes?: number, ): Promise<'written' | 'blank'> { const { writeFile } = await import('node:fs/promises'); const page = await pdf.getPage(pageNo); const base = page.getViewport({ scale: 1 }); let scale = Math.min( 2, maxWidth / base.width, maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY, ); let jpeg: Buffer | undefined; let last: import('@napi-rs/canvas').Canvas | undefined; // Without maxBytes this runs once, exactly as before. With it: up to 4 scales \u00d7 3 qualities. for (let attempt = 0; attempt < (maxBytes ? 4 : 1); attempt++, scale *= 0.8) { const viewport = page.getViewport({ scale }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); last = canvas; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement, }).promise; for (const q of maxBytes ? [quality, quality - 10, quality - 20] : [quality]) { jpeg = await canvas.encode('jpeg', Math.max(20, q)); if (!maxBytes || jpeg.length <= maxBytes) break; } if (!maxBytes || (jpeg && jpeg.length <= maxBytes)) break; } if (!jpeg) throw new Error(`page $" +
  "{pageNo} did not render`); if (last && flatCanvas(last) && (await pageHasPaint(page))) { const retryScale = Math.min( 1, maxWidth / base.width, maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY, ); const viewport = page.getViewport({ scale: retryScale }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement, }).promise; if (flatCanvas(canvas)) { page.cleanup(); return 'blank'; } for (const q of maxBytes ? [quality, quality - 10, quality - 20] : [quality]) { jpeg = await canvas.encode('jpeg', Math.max(20, q)); if (!maxBytes || jpeg.length <= maxBytes) break; } } const tmp = `$" +
  '{target}.$' +
  '{process.pid}.$' +
  "{randomUUID()}.tmp`; try { await writeFile(tmp, jpeg); await rename(tmp, target); } catch (err) { await rm(tmp, { force: true }); throw err; } page.cleanup(); return 'written'; }";

const OPTIONS_BODY =
  'return { // pdf.js transfers the buffer to its worker (detaching it): always hand it a copy. data: new Uint8Array(data), // Off: with it on, pdf.js skips standardFontDataUrl and asks for system fonts, which the image has none of. useSystemFonts: false, cMapPacked: true, ...assets, ...(canvasFactory ? { CanvasFactory: canvasFactory } : {}), };';

const ROOTS =
  "const roots = [ path.join(cwd, 'public', 'pdfjs'), path.join(cwd, 'apps', 'web', 'public', 'pdfjs'), path.join(cwd, 'node_modules', 'pdfjs-dist'), path.join(cwd, 'apps', 'web', 'node_modules', 'pdfjs-dist'), ];";

const ASSETS_MAP =
  "const ASSETS = { standardFontDataUrl: 'standard_fonts', cMapUrl: 'cmaps', wasmUrl: 'wasm', iccUrl: 'iccs', } as const;";

const GLOBALS =
  'Object.assign(globalThis, { Path2D: canvas.Path2D, DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, });';

const CANVAS_FACTORY =
  "class CanvasFactory { create(width: number, height: number) { const c = canvas.createCanvas(width, height); return { canvas: c, context: c.getContext('2d') }; } reset(entry: { canvas: { width: number; height: number } }, width: number, height: number) { entry.canvas.width = width; entry.canvas.height = height; } destroy(entry: { canvas: { width: number; height: number } }) { entry.canvas.width = 0; entry.canvas.height = 0; } }";

describe('render smoke mirrors the server render path', () => {
  it('slides.ts opens every PDF through openPdf and the shared canvas loader', () => {
    const collapsed = collapse(slides);
    expect(count(slides, '.getDocument('), HINT).toBe(0);
    expect(count(collapsed, 'openPdf(data, { canvasFactory: canvas.CanvasFactory })'), HINT).toBe(2);
    expect(count(collapsed, 'await loadPdfCanvas()'), HINT).toBe(2);
    expect(slides, HINT).not.toContain("await import('@napi-rs/canvas')");
    expect(slides, HINT).not.toContain("await import('pdfjs-dist");
  });

  it('openPdf options (system fonts off, packed CMaps, assets, canvas factory) are unchanged', () => {
    const start = open.indexOf('export function pdfjsOptions(');
    expect(start, HINT).toBeGreaterThan(-1);
    const bodyStart = open.indexOf('return {', start);
    const bodyEnd = open.indexOf('\n  };\n', bodyStart);
    expect(collapse(open.slice(bodyStart, bodyEnd + 5)), HINT).toBe(OPTIONS_BODY);
    expect(collapse(open), HINT).toContain(ASSETS_MAP);
  });

  it('asset roots keep public/pdfjs before the package copy', () => {
    expect(collapse(open), HINT).toContain(ROOTS);
  });

  it('the canvas loader installs the app canvas globals and the mirrored CanvasFactory', () => {
    const collapsed = collapse(canvasSrc);
    expect(collapsed, HINT).toContain(GLOBALS);
    expect(collapsed, HINT).toContain(CANVAS_FACTORY);
  });

  it('renderPageTo (scale, white fill, page.render, quality and scale loop, encode) is unchanged', () => {
    expect(renderPageToBody(), HINT).toBe(RENDER_PAGE_TO);
  });
});
