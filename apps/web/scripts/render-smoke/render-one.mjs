// Child process of the render smoke: renders page 1 of one synthetic PDF with one variant, the way
// apps/web/src/lib/slides.ts does (the `prod` variant mirrors lib/slides.ts + core/pdf/open.ts + lib/pdf-canvas.ts), and prints one `RESULT {json}` line.
// The blank-render guard of lib/slides.ts (flat-colour check and retry) is deliberately not mirrored: the smoke judges the first render.
// Each render runs in its own process so a native abort in @napi-rs/canvas shows up as a crash, not a dead harness.
// Usage: node render-one.mjs --app-root <dir> --manifest <manifest.json> --case <id> --variant <name> --out <dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAppModules } from './resolve-app.mjs';

// The MCP page-image parameters (lib/mcp/content.ts loadPageImages).
const MAX_WIDTH = 1024;
const MAX_HEIGHT = 1568;
const QUALITY = 60;
const MAX_BYTES = 72_000;
const WHITE_BELOW = 235;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const appRoot = path.resolve(args['app-root']);
const variant = args.variant;
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...a) => {
    const line = a.map(String).join(' ').split('\n')[0].slice(0, 300);
    if (logs.length < 30 && !logs.includes(line)) logs.push(line);
  };
}
const emit = (obj) => process.stdout.write(`RESULT ${JSON.stringify({ ...obj, logs })}\n`);

const prod = variant === 'prod';
const oneCanvas = prod || variant.startsWith('one-canvas');
const withAssets = prod || variant.includes('assets');
const noSystemFonts = prod || variant.endsWith('-nosys');

async function main() {
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  const spec = manifest.cases.find((c) => c.id === args.case);
  if (!spec) throw new Error(`unknown case ${args.case}`);

  // Resolve exactly as the built app does (see resolve-app.mjs).
  const resolved = resolveAppModules(appRoot);
  const appRequire = resolved.appRequire;
  const canvas = appRequire(resolved.canvasSpecifier);
  const pdfPath = resolved.pdfPath;
  const pdfjsRoot = path.resolve(path.dirname(pdfPath), '..', '..');

  if (oneCanvas) {
    // Before pdfjs loads: its Node polyfill only sets these when they are unset.
    Object.assign(globalThis, {
      Path2D: canvas.Path2D,
      DOMMatrix: canvas.DOMMatrix,
      ImageData: canvas.ImageData,
    });
  }
  const pdfjs = await import(pathToFileURL(pdfPath).href);

  const options = {
    data: new Uint8Array(readFileSync(path.join(path.dirname(args.manifest), spec.file))),
    useSystemFonts: true,
  };
  if (withAssets) {
    const dirOf = (name) =>
      [path.join(appRoot, 'public', 'pdfjs', name), path.join(pdfjsRoot, name)].find((d) => existsSync(d));
    const fonts = dirOf('standard_fonts');
    const cmaps = dirOf('cmaps');
    const wasm = dirOf('wasm');
    const iccs = dirOf('iccs');
    if (fonts) options.standardFontDataUrl = `${fonts}/`;
    if (cmaps) {
      options.cMapUrl = `${cmaps}/`;
      options.cMapPacked = true;
    }
    if (wasm) options.wasmUrl = `${wasm}/`;
    if (iccs) options.iccUrl = `${iccs}/`;
  }
  if (noSystemFonts) options.useSystemFonts = false;
  if (oneCanvas) {
    options.CanvasFactory = class {
      create(width, height) {
        const c = canvas.createCanvas(width, height);
        return { canvas: c, context: c.getContext('2d') };
      }
      reset(entry, width, height) {
        entry.canvas.width = width;
        entry.canvas.height = height;
      }
      destroy(entry) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    };
  }

  const pdf = await pdfjs.getDocument(options).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  let scale = Math.min(2, MAX_WIDTH / base.width, MAX_HEIGHT / base.height);
  let jpeg;
  let viewport;
  let cv;
  for (let attempt = 0; attempt < 4; attempt++, scale *= 0.8) {
    viewport = page.getViewport({ scale });
    cv = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport, canvas: cv }).promise;
    for (const q of [QUALITY, QUALITY - 10, QUALITY - 20]) {
      jpeg = await cv.encode('jpeg', Math.max(20, q));
      if (jpeg.length <= MAX_BYTES) break;
    }
    if (jpeg.length <= MAX_BYTES) break;
  }
  mkdirSync(path.join(args.out, 'jpeg'), { recursive: true });
  writeFileSync(path.join(args.out, 'jpeg', `${spec.id}.${variant}.jpg`), jpeg);

  // Measure the encoded JPEG, which is what a client would be shown.
  const img = await canvas.loadImage(jpeg);
  const m = canvas.createCanvas(img.width, img.height);
  const mctx = m.getContext('2d');
  mctx.drawImage(img, 0, 0);
  const { data, width, height } = mctx.getImageData(0, 0, img.width, img.height);
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      lo = Math.min(lo, data[i + k]);
      hi = Math.max(hi, data[i + k]);
    }
  }
  const ratioIn = (x0, y0, x1, y1) => {
    let non = 0;
    let n = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) {
        const i = (y * width + x) * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) < WHITE_BELOW) non++;
        n++;
      }
    }
    return n ? non / n : 0;
  };
  const regions = spec.regions.map((r) => {
    const [ax, ay, bx, by] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
    return {
      name: r.name,
      ratio: ratioIn(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)),
    };
  });
  emit({
    status: 'ok',
    width,
    height,
    scale: Number(scale.toFixed(4)),
    jpegBytes: jpeg.length,
    ratio: ratioIn(0, 0, width, height),
    uniform: hi - lo <= 6,
    regions,
  });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  emit({
    status: 'error',
    message: String(err?.message ?? err)
      .replace(/\s+/g, ' ')
      .slice(0, 300),
  });
  process.exit(1);
}
