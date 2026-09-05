// Copies pdf.js's legacy worker into public/ with the upsert polyfill prepended, so the browser worker runs on
// engines that lack Map.prototype.getOrInsertComputed (iOS 18 Safari). Keep in sync with src/lib/pdf-polyfill.ts.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const src = path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'legacy/build/pdf.worker.min.mjs',
);
const polyfill = readFileSync(new URL('../src/lib/pdf-polyfill.ts', import.meta.url), 'utf8').match(
  /PDF_POLYFILL_SOURCE = `([\s\S]*?)`;/,
)?.[1];
if (!polyfill) throw new Error('polyfill source not found');
mkdirSync('public', { recursive: true });
writeFileSync('public/pdf.worker.min.mjs', `${polyfill}\n${readFileSync(src, 'utf8')}`);
// Standard fonts (Liberation/Foxit substitutes for non-embedded fonts, incl. Symbol) and CMaps for CID fonts.
// Without them pdf.js falls back to the browser's default face and shows boxes for missing glyphs.
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
cpSync(path.join(root, 'standard_fonts'), 'public/pdfjs/standard_fonts', { recursive: true });
cpSync(path.join(root, 'cmaps'), 'public/pdfjs/cmaps', { recursive: true });
