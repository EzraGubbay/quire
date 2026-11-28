import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The render smoke's `prod` variant (scripts/render-smoke/render-one.mjs) re-implements how lib/slides.ts renders a
// page. This tripwire pins every part of slides.ts the smoke mirrors, so the two get updated together. It compares
// whitespace-collapsed text, so formatting changes pass but any change to the mirrored logic fails.
const slides = readFileSync(path.join(process.cwd(), 'src/lib/slides.ts'), 'utf8');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const HINT =
  'lib/slides.ts changed how it renders: update the prod variant in scripts/render-smoke/render-one.mjs';

/** The body of renderPageTo, from its signature to page.cleanup(). */
function renderPageToBody(): string {
  const start = slides.indexOf('async function renderPageTo(');
  const endMarker = 'page.cleanup();\n}';
  const end = slides.indexOf(endMarker, start);
  expect(start, HINT).toBeGreaterThan(-1);
  expect(end, HINT).toBeGreaterThan(start);
  return collapse(slides.slice(start, end + endMarker.length));
}

const RENDER_PAGE_TO =
  "async function renderPageTo( pdf: PdfDoc, createCanvas: CreateCanvas, pageNo: number, target: string, maxWidth: number, quality: number, maxHeight?: number, maxBytes?: number, ): Promise<void> { const { writeFile } = await import('node:fs/promises'); const page = await pdf.getPage(pageNo); const base = page.getViewport({ scale: 1 }); let scale = Math.min( 2, maxWidth / base.width, maxHeight ? maxHeight / base.height : Number.POSITIVE_INFINITY, ); let jpeg: Buffer | undefined; // Without maxBytes this runs once, exactly as before. With it: up to 4 scales \u00d7 3 qualities. for (let attempt = 0; attempt < (maxBytes ? 4 : 1); attempt++, scale *= 0.8) { const viewport = page.getViewport({ scale }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement, }).promise; for (const q of maxBytes ? [quality, quality - 10, quality - 20] : [quality]) { jpeg = await canvas.encode('jpeg', Math.max(20, q)); if (!maxBytes || jpeg.length <= maxBytes) break; } if (!maxBytes || (jpeg && jpeg.length <= maxBytes)) break; } if (!jpeg) throw new Error(`page $" +
  '{pageNo} did not render`); const tmp = `$' +
  '{target}.$' +
  '{process.pid}.$' +
  '{randomUUID()}.tmp`; try { await writeFile(tmp, jpeg); await rename(tmp, target); } catch (err) { await rm(tmp, { force: true }); throw err; } page.cleanup(); }';

describe('render smoke mirrors lib/slides.ts', () => {
  it('has exactly two getDocument calls, both with the mirrored options (renderPageImages and renderPages)', () => {
    expect(count(slides, '.getDocument('), HINT).toBe(2);
    expect(
      count(
        collapse(slides),
        'pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise',
      ),
      HINT,
    ).toBe(2);
  });

  it('imports canvas and pdf.js dynamically in both render paths', () => {
    const collapsed = collapse(slides);
    expect(count(collapsed, "import('@napi-rs/canvas'),"), HINT).toBe(2);
    expect(count(collapsed, "import('pdfjs-dist/legacy/build/pdf.mjs'),"), HINT).toBe(2);
  });

  it('renderPageTo (scale, white fill, page.render, quality and scale loop, encode) is unchanged', () => {
    expect(renderPageToBody(), HINT).toBe(RENDER_PAGE_TO);
  });
});
