import { existsSync } from 'node:fs';
import path from 'node:path';

const ASSETS = {
  standardFontDataUrl: 'standard_fonts',
  cMapUrl: 'cmaps',
  wasmUrl: 'wasm',
  iccUrl: 'iccs',
} as const;

export type PdfAssetUrls = Partial<Record<keyof typeof ASSETS, string>>;

/**
 * pdf.js data dirs as absolute paths with a trailing slash. public/pdfjs (copied at build, shipped in the image)
 * wins; the package's own copy covers dev and tests without a build. Resolved per asset, so a stale public/pdfjs
 * missing a newer dir still finds it.
 */
export function pdfAssetUrls(cwd: string = process.cwd()): PdfAssetUrls {
  const roots = [
    path.join(cwd, 'public', 'pdfjs'),
    path.join(cwd, 'apps', 'web', 'public', 'pdfjs'),
    path.join(cwd, 'node_modules', 'pdfjs-dist'),
    path.join(cwd, 'apps', 'web', 'node_modules', 'pdfjs-dist'),
  ];
  const out: PdfAssetUrls = {};
  for (const [key, dir] of Object.entries(ASSETS) as [keyof typeof ASSETS, string][]) {
    const root = roots.find((r) => existsSync(path.join(r, dir)));
    if (root) out[key] = `${path.join(root, dir)}/`;
  }
  return out;
}

const assetCache = new Map<string, PdfAssetUrls>();
let warned = false;

function assetsFor(cwd: string = process.cwd()): PdfAssetUrls {
  let assets = assetCache.get(cwd);
  if (!assets) {
    assets = pdfAssetUrls(cwd);
    assetCache.set(cwd, assets);
    if (!assets.standardFontDataUrl && !warned) {
      warned = true;
      console.warn('pdf.js standard font data not found: non-embedded fonts will not render');
    }
  }
  return assets;
}

/** The getDocument options every server-side open uses. Exported for the render-smoke mirror tripwire. */
export function pdfjsOptions(data: Uint8Array, assets: PdfAssetUrls, canvasFactory?: unknown) {
  return {
    // pdf.js transfers the buffer to its worker (detaching it): always hand it a copy.
    data: new Uint8Array(data),
    // Off: with it on, pdf.js skips standardFontDataUrl and asks for system fonts, which the image has none of.
    useSystemFonts: false,
    cMapPacked: true,
    ...assets,
    ...(canvasFactory ? { CanvasFactory: canvasFactory } : {}),
  };
}

/** Opens a PDF with pdf.js (legacy build) using the bundled standard fonts, CMaps, wasm decoders and ICC profiles. */
export async function openPdf(data: Uint8Array, opts: { canvasFactory?: unknown; cwd?: string } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument(
    pdfjsOptions(data, assetsFor(opts.cwd), opts.canvasFactory) as Parameters<typeof pdfjs.getDocument>[0],
  ).promise;
}

export type PdfDocument = Awaited<ReturnType<typeof openPdf>>;
