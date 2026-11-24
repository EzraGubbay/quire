// Test-only: builds a small, valid PDF in memory so extraction tests run through real pdf.js without a font
// file or any real document. Text is set in Type 3 fonts whose glyphs are all the same box (only the advance
// width and the ToUnicode map matter to a text extractor), so Hebrew, Latin, digits and math symbols all work.
// Output is byte-for-byte deterministic.

/** Every glyph advances this fraction of the font size (combining marks advance 0, as TeX's `\not` does). */
export const GLYPH_EM = 0.5;

export interface TinyRun {
  /** Any name; each distinct name becomes its own font (pdf.js starts a new text item at a font change). */
  font: string;
  size: number;
  /** Left end of the baseline, in points from the bottom-left corner. */
  x: number;
  y: number;
  /** Glyphs in the order they are painted, left to right (so right-to-left text is given reversed). */
  glyphs: string;
}

export interface TinyPage {
  /** Painted in this order (the content-stream order pdf.js reports). */
  runs: TinyRun[];
  /** An embedded raster image drawn into this box. */
  image?: { x: number; y: number; width: number; height: number };
}

export const PAGE_WIDTH = 595;
export const PAGE_HEIGHT = 842;

const isMark = (c: string) => /\p{M}/u.test(c);
export const glyphsWidth = (glyphs: string, size: number): number =>
  Array.from(glyphs).filter((c) => !isMark(c)).length * GLYPH_EM * size;

/**
 * Logical right-to-left text → the left-to-right glyph order a PDF paints (digit groups keep their order).
 * Brackets are left as they are: pass the shape the generator would draw.
 */
export function visualOrder(logical: string): string {
  const parts = logical.match(/\p{Nd}+(?:[.:/]\p{Nd}+)*|[^\p{Nd}]+/gu) ?? [];
  return parts
    .reverse()
    .map((p) => (/^\p{Nd}/u.test(p) ? p : Array.from(p).reverse().join('')))
    .join('');
}

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
const utf16 = (c: string) => Array.from({ length: c.length }, (_, i) => hex(c.charCodeAt(i), 4)).join('');

export function tinyPdf(pages: TinyPage[]): Uint8Array {
  const fonts = new Map<string, string[]>();
  for (const page of pages) {
    for (const run of page.runs) {
      const chars = fonts.get(run.font) ?? [];
      for (const c of Array.from(run.glyphs)) if (!chars.includes(c)) chars.push(c);
      fonts.set(run.font, chars);
    }
  }
  const fontNames = [...fonts.keys()];

  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const stream = (dict: string, data: string) =>
    `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;

  const catalog = add('');
  const pageTree = add('');
  const glyph = add(stream('', '500 0 0 0 500 700 d1 50 0 400 600 re f'));
  const image = add(
    stream(
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8',
      '\x20\x60\xA0\xE0',
    ),
  );
  const fontIds = fontNames.map((name) => {
    const chars = fonts.get(name) as string[];
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '/CMapName /Tiny def /CMapType 2 def',
      '1 begincodespacerange <00> <FF> endcodespacerange',
      `${chars.length} beginbfchar`,
      ...chars.map((c, i) => `<${hex(i + 1, 2)}> <${utf16(c)}>`),
      'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
    ].join('\n');
    const toUnicode = add(stream('', cmap));
    // pdf.js only starts a new text item at a font change when the fonts' names differ.
    const descriptor = add(
      `<< /Type /FontDescriptor /FontName /Tiny-${name} /Flags 4 /FontBBox [0 0 500 700] /ItalicAngle 0 ` +
        '/Ascent 700 /Descent 0 /CapHeight 700 /StemV 80 >>',
    );
    return add(
      [
        '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0]',
        `/CharProcs << /box ${glyph} 0 R >>`,
        `/Encoding << /Type /Encoding /Differences [1 ${chars.map(() => '/box').join(' ')}] >>`,
        `/FirstChar 1 /LastChar ${chars.length}`,
        `/Widths [${chars.map((c) => (isMark(c) ? 0 : GLYPH_EM * 1000)).join(' ')}]`,
        `/Resources << >> /ToUnicode ${toUnicode} 0 R /FontDescriptor ${descriptor} 0 R >>`,
      ].join('\n'),
    );
  });
  const fontResources = fontNames.map((_, i) => `/F${i} ${fontIds[i]} 0 R`).join(' ');

  const pageIds = pages.map((page) => {
    const ops: string[] = [];
    for (const run of page.runs) {
      const chars = fonts.get(run.font) as string[];
      const codes = Array.from(run.glyphs)
        .map((c) => hex(chars.indexOf(c) + 1, 2))
        .join('');
      ops.push(`BT /F${fontNames.indexOf(run.font)} ${run.size} Tf ${run.x} ${run.y} Td <${codes}> Tj ET`);
    }
    if (page.image) {
      const { x, y, width, height } = page.image;
      ops.push(`q ${width} 0 0 ${height} ${x} ${y} cm /Im0 Do Q`);
    }
    const content = add(stream('', ops.join('\n')));
    return add(
      `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << ${fontResources} >> /XObject << /Im0 ${image} 0 R >> >> ` +
        `/Contents ${content} 0 R >>`,
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] =
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** One part of a row: a font, text in logical order, and the gap (pt) to the part painted before it. */
export type RowPart = {
  font: string;
  text: string;
  gap?: number;
  size?: number;
  rise?: number;
  rtl?: boolean;
};

/**
 * A row painted left to right from `x` (TeX style): parts are listed in visual order; right-to-left parts
 * are reversed into glyph order.
 */
export function visualRow(x: number, y: number, size: number, parts: RowPart[]): TinyRun[] {
  let pen = x;
  return parts.map((p) => {
    const glyphs = p.rtl ? visualOrder(p.text) : p.text;
    pen += p.gap ?? 0;
    const run = { font: p.font, size: p.size ?? size, x: pen, y: y + (p.rise ?? 0), glyphs };
    pen += glyphsWidth(glyphs, run.size);
    return run;
  });
}

/**
 * A right-to-left row painted in logical order from the right edge `x` (Word style): each part is placed to
 * the left of the one before it. A part with `ltrGroup` is a list of adjacent runs laid left to right as one
 * block (a number written digit by digit).
 */
export function logicalRow(
  x: number,
  y: number,
  size: number,
  parts: (RowPart | { ltrGroup: RowPart[]; gap?: number })[],
): TinyRun[] {
  let pen = x;
  const runs: TinyRun[] = [];
  for (const p of parts) {
    pen -= p.gap ?? 0;
    const group = 'ltrGroup' in p ? p.ltrGroup : [p];
    const prepared = group.map((g) => ({ g, glyphs: g.rtl ? visualOrder(g.text) : g.text }));
    const width = prepared.reduce((w, q) => w + glyphsWidth(q.glyphs, q.g.size ?? size), 0);
    pen -= width;
    let at = pen;
    for (const q of prepared) {
      runs.push({ font: q.g.font, size: q.g.size ?? size, x: at, y, glyphs: q.glyphs });
      at += glyphsWidth(q.glyphs, q.g.size ?? size);
    }
  }
  return runs;
}
