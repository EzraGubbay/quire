// Synthetic one-page PDFs for the render smoke (#122). Each case exercises exactly one pdf.js rendering path, with
// no caption, so a missing feature reads as a blank region instead of hiding behind text. Zero dependencies and
// plain ESM so it runs inside the runtime image with bare `node`. Output is byte-for-byte deterministic.
//
// Usage: node smoke-pdfs.mjs <outDir> [--font-dir <dir>]   (writes <id>.pdf and manifest.json)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PAGE = { w: 720, h: 405 };

// Regenerate from apps/web with:
//   node -e "const {createCanvas}=require('@napi-rs/canvas');const c=createCanvas(96,64);const x=c.getContext('2d');
//   const g=x.createLinearGradient(0,0,96,64);g.addColorStop(0,'#1d4ed8');g.addColorStop(1,'#f59e0b');x.fillStyle=g;
//   x.fillRect(0,0,96,64);x.fillStyle='#111';x.fillRect(10,10,30,20);
//   process.stdout.write(c.encodeSync('jpeg',85).toString('base64'))"
// A synthetic 96x64 baseline (SOF0) 3-component JPEG.
export const JPEG_BASE64 = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh',
  'Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB',
  'UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA',
  'AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y',
  'WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM',
  'ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkM',
  'EQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4e',
  'Hh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCABAAGADASIAAhEBAxEB/8QAGgABAQEBAQEBAAAAAAAAAAAAAgQH',
  'AwYACP/EACUQAAMAAQMDBQADAAAAAAAAAAACAwEEBQYRMdISEyGjpAdzs//EABoBAQACAwEAAAAAAAAAAAAAAAUEBwEGCAP/xAAm',
  'EQACAwABAgQHAAAAAAAAAAAAAwECBBEFMQYSIUFRYXGRodHw/9oADAMBAAIRAxEAPwDN5qUzUE1PB8u5HvW38i1Wk0ms9uM/R6V9',
  'pM9OqLnPznHXvktfqvU6Y6Re8TMTPHp/fI1nLmls8QaPNSiamOY5lyTHbcvon4ixzbk+O25/RPxNVd19F+0T+P2KUxWr7wbTNSia',
  'mIY5zynHbdPzy8TdJqQLbquiZqSqK8o5qUzUE1KJqEaXE9VBTUpmoJqUTUA0uEVUHNSiagmpTNQDS4RVQyqamU/yDjpy/XY/r/zU',
  '1yame8y4tvu48l1es0Wh92FPR6W91F69EXGfjOcZ74yXd4i87kRWkc+vt9JK/wAERW0zPwPDHx6THB+U57bX98/IWOB8rz22r9Ev',
  'I02UMjvWfsLRaJ7SeZP09NTCccA5bnttP6JeRvk1M1tNInk9KV5kU1KJqCalM1C9LhBVBzU7zUM1KJqA6XCKqDmpRNQTUomoBpcI',
  'KoZXNSiahmpRNToXS4rZVBzU7zUM1KJqAaXCKqDmpRNQTUomoBpcIqoOalE1DNTvNQHS4RVQc1KZqCalE1ANLhFVBzUomoJqUTUB',
  '0uEFUMrmpRNQzU7zU6E0uK3VQc1KZqCalE1AdLhBVBTUpmoJqUTUA0uEVUHNSiagmpTNQDS4RVQU1KJqGalE1AdLhFVBTUpmoJqU',
  'TUB0uEVUP//Z',
].join('');

export const FONT_FILE = 'LiberationSans-Regular.ttf';

const latin1 = (s) => Buffer.from(s, 'latin1');

/** Minimal PDF writer: objects are numbered from 1 in insertion order. */
class Pdf {
  constructor() {
    this.objs = [];
  }
  /** Reserve or add an object; `body` is a string or Buffer. Returns its number. */
  add(body = '') {
    this.objs.push(body);
    return this.objs.length;
  }
  set(id, body) {
    this.objs[id - 1] = body;
  }
  stream(dict, data) {
    const buf = Buffer.isBuffer(data) ? data : latin1(data);
    return Buffer.concat([
      latin1(`<< ${dict} /Length ${buf.length} >>\nstream\n`),
      buf,
      latin1('\nendstream'),
    ]);
  }
  addStream(dict, data) {
    return this.add(this.stream(dict, data));
  }
  toBuffer() {
    const parts = [latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    let offset = parts[0].length;
    const offsets = [];
    this.objs.forEach((body, i) => {
      const chunk = Buffer.concat([
        latin1(`${i + 1} 0 obj\n`),
        Buffer.isBuffer(body) ? body : latin1(body),
        latin1('\nendobj\n'),
      ]);
      offsets.push(offset);
      offset += chunk.length;
      parts.push(chunk);
    });
    const xref = [`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`];
    for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${this.objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
    parts.push(latin1(xref.join('')));
    return Buffer.concat(parts);
  }
}

/** A one-page document: `fill(pdf)` adds its own objects and returns `{ content, resources }`. */
function onePage(fill) {
  const pdf = new Pdf();
  pdf.add('<< /Type /Catalog /Pages 2 0 R >>');
  pdf.add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  pdf.add('');
  pdf.add('');
  const { content, resources } = fill(pdf);
  pdf.set(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << ${resources} >> /Contents 4 0 R >>`,
  );
  pdf.set(4, pdf.stream('', content));
  return pdf.toBuffer();
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A Type 3 font whose 26 capital-letter glyphs are all the same box (only the shape matters for rendering). */
function type3Font(pdf) {
  const glyph = pdf.addStream('', '500 0 0 0 500 700 d1 50 0 400 600 re f');
  const names = Array.from(ALPHABET, (_, i) => `/g${i}`);
  return pdf.add(
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] ` +
      `/CharProcs << ${names.map((n) => `${n} ${glyph} 0 R`).join(' ')} >> ` +
      `/Encoding << /Type /Encoding /Differences [65 ${names.join(' ')}] >> ` +
      `/FirstChar 65 /LastChar 90 /Widths [${Array(26).fill(500).join(' ')}] >>`,
  );
}

const helveticaFont = (pdf) =>
  pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

const textRows = (font, size, x, y, rows, lead) =>
  `BT /${font} ${size} Tf ${x} ${y} Td ${lead} TL ${rows.map((r) => `(${r}) Tj T*`).join(' ')} ET\n`;

const gradientGray = (n) => {
  const out = Buffer.alloc(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) out[y * n + x] = Math.floor(((x + y) * 200) / (2 * (n - 1)));
  return out;
};

const regionsOf = (list, min = 0.02) =>
  list.map(([name, x, y, w, h, m]) => ({ name, x, y, w, h, min: m ?? min }));

/** Per-region minimum non-white ratios, calibrated against the best variant inside the runtime image. */
const MIN = {};
const minOf = (id, name, fallback = 0.005) => MIN[`${id}/${name}`] ?? fallback;

const CASES = [
  {
    id: 'text-type3',
    title: 'Type 3 font text',
    feature: 'Type 3 glyph procs (box glyphs), drawn through constructPath/Path2D',
    regions: [
      ['row1', 40, 300, 280, 22],
      ['row2', 40, 260, 280, 22],
      ['row3', 40, 220, 280, 22],
    ],
    build: () =>
      onePage((pdf) => {
        const f = type3Font(pdf);
        return {
          resources: `/Font << /F1 ${f} 0 R >>`,
          content: textRows(
            'F1',
            28,
            40,
            300,
            ['ABCDEFGHIJKLMNOPQRST', 'UVWXYZABCDEFGHIJKLMN', 'OPQRSTUVWXYZABCDEFGH'],
            40,
          ),
        };
      }),
  },
  {
    id: 'text-helvetica',
    title: 'Non-embedded Helvetica text',
    feature: 'Standard-14 font without an embedded program (needs standard font data or a system font)',
    regions: [
      ['row1', 40, 300, 420, 30],
      ['row2', 40, 250, 420, 30],
      ['row3', 40, 200, 420, 30],
    ],
    build: () =>
      onePage((pdf) => {
        const f = helveticaFont(pdf);
        return {
          resources: `/Font << /F1 ${f} 0 R >>`,
          content: textRows(
            'F1',
            36,
            40,
            300,
            ['Render smoke text', 'Second line of words', 'Third line goes here'],
            50,
          ),
        };
      }),
  },
  {
    id: 'text-embedded-truetype',
    title: 'Embedded TrueType text',
    feature: 'Simple TrueType font with an embedded program, drawn from glyph outlines (what real decks use)',
    needsFont: true,
    regions: [
      ['row1', 40, 300, 420, 30],
      ['row2', 40, 250, 420, 30],
      ['row3', 40, 200, 420, 30],
    ],
    build: ({ fontBytes }) =>
      onePage((pdf) => {
        const file = pdf.addStream(`/Length1 ${fontBytes.length}`, fontBytes);
        const desc = pdf.add(
          `<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [-200 -300 1200 1000] ` +
            `/ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 700 /StemV 80 /FontFile2 ${file} 0 R >>`,
        );
        const f = pdf.add(
          `<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 126 ` +
            `/Widths [${Array(95).fill(556).join(' ')}] /FontDescriptor ${desc} 0 R /Encoding /WinAnsiEncoding >>`,
        );
        return {
          resources: `/Font << /F1 ${f} 0 R >>`,
          content: textRows(
            'F1',
            36,
            40,
            300,
            ['Render smoke text', 'Second line of words', 'Third line goes here'],
            50,
          ),
        };
      }),
  },
  {
    id: 'vector-shapes',
    title: 'Vector diagram',
    feature:
      'Filled rectangles, thick strokes, a Bezier curve, a dashed line and a polygon (constructPath/Path2D)',
    regions: [
      ['box-blue', 40, 250, 160, 90],
      ['box-orange', 280, 250, 160, 90],
      ['box-green', 520, 250, 160, 90],
      ['polygon', 500, 60, 180, 140],
      ['curve', 40, 120, 360, 80, 0.005],
    ],
    build: () =>
      onePage(() => ({
        resources: '',
        content: [
          '0.114 0.306 0.847 rg 40 250 160 90 re f',
          '0.96 0.62 0.04 rg 280 250 160 90 re f',
          '0.1 0.6 0.3 rg 520 250 160 90 re f',
          '0 0 0 RG 3 w 200 295 m 280 295 l S 440 295 m 520 295 l S',
          '0.9 0.1 0.1 RG 40 200 m 150 120 300 120 400 200 c S',
          '0 0 0 RG [8 6] 0 d 40 80 m 480 80 l S [] 0 d',
          '0.5 0.2 0.7 rg 500 120 m 600 200 l 680 130 l 620 60 l h f',
        ].join('\n'),
      })),
  },
  {
    id: 'shading-axial',
    title: 'Axial gradient',
    feature: 'Type 2 axial shading through a clip rectangle (sh operator)',
    regions: [['gradient', 60, 60, 600, 285, 0.5]],
    build: () =>
      onePage(() => ({
        resources:
          '/Shading << /Sh1 << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [60 0 660 0] ' +
          '/Function << /FunctionType 2 /Domain [0 1] /C0 [0.1 0.2 0.9] /C1 [0.95 0.6 0.1] /N 1 >> ' +
          '/Extend [true true] >> >>',
        content: 'q 60 60 600 285 re W n /Sh1 sh Q',
      })),
  },
  {
    id: 'image-raw-gray',
    title: 'Raw gray image',
    feature: '64x64 8-bit DeviceGray image, uncompressed (paintImageXObject via a temp canvas)',
    regions: [['image', 160, 50, 400, 300, 0.5]],
    build: () =>
      onePage((pdf) => {
        const im = pdf.addStream(
          '/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8',
          gradientGray(64),
        );
        return { resources: `/XObject << /Im1 ${im} 0 R >>`, content: 'q 400 0 0 300 160 50 cm /Im1 Do Q' };
      }),
  },
  {
    id: 'image-jpeg',
    title: 'JPEG image',
    feature: '96x64 DeviceRGB image with a DCTDecode filter',
    regions: [['image', 120, 40, 480, 320, 0.5]],
    build: () =>
      onePage((pdf) => {
        const im = pdf.addStream(
          '/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
          Buffer.from(JPEG_BASE64, 'base64'),
        );
        return { resources: `/XObject << /Im1 ${im} 0 R >>`, content: 'q 480 0 0 320 120 40 cm /Im1 Do Q' };
      }),
  },
  {
    id: 'image-smask',
    title: 'Image with soft mask',
    feature: '64x64 raw RGB image with a 64x64 gray soft mask (radial alpha)',
    regions: [['image', 160, 50, 400, 300, 0.1]],
    build: () =>
      onePage((pdf) => {
        const n = 64;
        const rgb = Buffer.alloc(n * n * 3);
        const alpha = Buffer.alloc(n * n);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const i = y * n + x;
            rgb[i * 3] = 30 + x * 2;
            rgb[i * 3 + 1] = 60;
            rgb[i * 3 + 2] = 200 - y * 2;
            const d = Math.hypot(x - n / 2, y - n / 2) / (n / 2);
            alpha[i] = Math.max(0, Math.min(255, Math.round(255 * (1.15 - d))));
          }
        }
        const mask = pdf.addStream(
          '/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8',
          alpha,
        );
        const im = pdf.addStream(
          `/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${mask} 0 R`,
          rgb,
        );
        return { resources: `/XObject << /Im1 ${im} 0 R >>`, content: 'q 400 0 0 300 160 50 cm /Im1 Do Q' };
      }),
  },
  {
    id: 'image-stencil-mask',
    title: 'Stencil mask image',
    feature: '1-bit /ImageMask checkerboard filled blue (paintImageMaskXObject)',
    regions: [['mask', 200, 40, 320, 320, 0.2]],
    build: () =>
      onePage((pdf) => {
        const rows = [];
        for (let y = 0; y < 32; y++) {
          const b = Math.floor(y / 4) % 2 === 0 ? 0xf0 : 0x0f;
          rows.push(b, b, b, b);
        }
        const im = pdf.addStream(
          '/Type /XObject /Subtype /Image /Width 32 /Height 32 /ImageMask true /BitsPerComponent 1',
          Buffer.from(rows),
        );
        return {
          resources: `/XObject << /Im1 ${im} 0 R >>`,
          content: '0 0 1 rg q 320 0 0 320 200 40 cm /Im1 Do Q',
        };
      }),
  },
  {
    id: 'transparency-group',
    title: 'Transparency group and soft mask',
    feature:
      'Form XObject with a transparency group under constant alpha 0.6, and again under a luminosity soft mask',
    regions: [
      ['group-alpha', 40, 60, 280, 280, 0.2],
      ['group-masked', 380, 100, 280, 200, 0.1],
    ],
    build: () =>
      onePage((pdf) => {
        const group = pdf.addStream(
          '/Type /XObject /Subtype /Form /BBox [0 0 340 405] /Group << /S /Transparency /CS /DeviceRGB >>',
          '1 0 0 rg 40 60 200 200 re f 0 0 1 rg 120 140 200 200 re f',
        );
        const maskForm = pdf.addStream(
          '/Type /XObject /Subtype /Form /BBox [0 0 340 405] /Group << /S /Transparency /CS /DeviceGray >>',
          '1 g 0 100 340 200 re f',
        );
        return {
          resources:
            `/XObject << /Fm1 ${group} 0 R >> /ExtGState << /GS1 << /CA 0.6 /ca 0.6 >> ` +
            `/GS2 << /SMask << /Type /Mask /S /Luminosity /G ${maskForm} 0 R >> >> >>`,
          content: 'q /GS1 gs /Fm1 Do Q\nq 1 0 0 1 340 0 cm /GS2 gs /Fm1 Do Q',
        };
      }),
  },
  {
    id: 'slide-combo',
    title: 'Slide with title, diagram, photo and label',
    feature: 'Helvetica title + vector diagram + JPEG + Type 3 label on one page; one region per element',
    regions: [
      ['title', 40, 340, 420, 36],
      ['diagram', 40, 150, 360, 120],
      ['photo', 460, 150, 200, 133, 0.5],
      ['label', 40, 60, 280, 20],
    ],
    build: () =>
      onePage((pdf) => {
        const helv = helveticaFont(pdf);
        const t3 = type3Font(pdf);
        const im = pdf.addStream(
          '/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
          Buffer.from(JPEG_BASE64, 'base64'),
        );
        return {
          resources: `/Font << /F1 ${helv} 0 R /F2 ${t3} 0 R >> /XObject << /Im1 ${im} 0 R >>`,
          content: [
            textRows('F1', 36, 40, 340, ['Slide title here'], 40),
            '0.114 0.306 0.847 rg 40 150 120 120 re f',
            '0.96 0.62 0.04 rg 280 150 120 120 re f',
            '0 0 0 RG 3 w 160 210 m 280 210 l S',
            'q 200 0 0 133 460 150 cm /Im1 Do Q',
            textRows('F2', 24, 40, 60, ['LABELTEXTHERE'], 30),
          ].join('\n'),
        };
      }),
  },
];

/**
 * Builds every smoke PDF. `fontDir` (a directory holding LiberationSans-Regular.ttf) is read at generation
 * time and never committed; without it the embedded-font case is reported in `skipped`.
 */
export function buildSmokeCases({ fontDir } = {}) {
  let fontBytes;
  if (fontDir) {
    try {
      fontBytes = readFileSync(path.join(fontDir, FONT_FILE));
    } catch {
      fontBytes = undefined;
    }
  }
  const cases = [];
  const skipped = [];
  for (const c of CASES) {
    if (c.needsFont && !fontBytes) {
      skipped.push({ id: c.id, reason: `${FONT_FILE} not found in the font directory` });
      continue;
    }
    cases.push({
      id: c.id,
      title: c.title,
      feature: c.feature,
      page: { ...PAGE },
      regions: regionsOf(
        c.regions.map(([name, x, y, w, h, m]) => [name, x, y, w, h, m ?? minOf(c.id, name)]),
      ),
      bytes: c.build({ fontBytes }),
    });
  }
  return { cases, skipped };
}

function cli(argv) {
  const out = argv[0];
  if (!out) throw new Error('usage: node smoke-pdfs.mjs <outDir> [--font-dir <dir>]');
  const i = argv.indexOf('--font-dir');
  const { cases, skipped } = buildSmokeCases({ fontDir: i >= 0 ? argv[i + 1] : undefined });
  mkdirSync(out, { recursive: true });
  const manifest = { cases: [], skipped };
  for (const c of cases) {
    writeFileSync(path.join(out, `${c.id}.pdf`), c.bytes);
    const { bytes, ...meta } = c;
    manifest.cases.push({ ...meta, file: `${c.id}.pdf`, size: bytes.length });
  }
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli(process.argv.slice(2));
