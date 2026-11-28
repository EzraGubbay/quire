// Test-only: builds a small, valid PPTX package in memory so PPTX reader tests run against real zip and
// OOXML bytes without any real deck. Every builder returns an XML string, so a test reads like the slide it
// describes. All text goes through escapeXml. Output is byte-for-byte deterministic in any time zone.
import { crc32, deflateRawSync } from 'node:zlib';

const enc = new TextEncoder();

/**
 * A minimal zip writer: deterministic (fixed timestamp), deflate by default, stored with `store`. Test-only;
 * it exists so tests need no zip library and can build the hostile archives the reader must refuse.
 */
export function zipBytes(
  entries: Record<string, string | Uint8Array>,
  opts: { store?: boolean; level?: number } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number, fill: (v: DataView) => void): [Uint8Array, DataView] => {
    const b = new Uint8Array(size);
    const v = new DataView(b.buffer);
    fill(v);
    return [b, v];
  };
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const method = opts.store ? 0 : 8;
    const body = opts.store ? data : deflateRawSync(data, { level: opts.level ?? 6 });
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const common = (v: DataView, at: number) => {
      v.setUint16(at, 0x0800, true); // UTF-8 names
      v.setUint16(at + 2, method, true);
      v.setUint16(at + 4, 0, true); // time
      v.setUint16(at + 6, 0x21, true); // 1980-01-01
      v.setUint32(at + 8, crc, true);
      v.setUint32(at + 12, body.length, true);
      v.setUint32(at + 16, data.length, true);
      v.setUint16(at + 20, nameBytes.length, true);
    };
    const [local] = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      common(v, 6);
    });
    const [cen] = header(46, (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      common(v, 8);
      v.setUint32(42, offset, true);
    });
    chunks.push(local, nameBytes, body);
    central.push(cen, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const [eocd] = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Object.keys(entries).length, true);
    v.setUint16(10, Object.keys(entries).length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, offset, true);
  });
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export const EMU_PER_INCH = 914400;

/** A shape box in EMU. */
export interface TinyBox {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const NS_A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = `${NS_R}`;
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const ROOT_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" xmlns:mc="${NS_MC}" xmlns:a14="${NS_A14}" xmlns:m="${NS_M}"`;

/** A text run. */
export const run = (text: string, opts: { lang?: string } = {}): string =>
  `<a:r><a:rPr lang="${opts.lang ?? 'en-US'}"/><a:t>${escapeXml(text)}</a:t></a:r>`;
export const br = (): string => '<a:br/>';
/** A field (slide number, date…) with its cached text. */
export const fld = (type: string, text: string): string =>
  `<a:fld id="{00000000-0000-0000-0000-000000000000}" type="${escapeXml(type)}"><a:rPr lang="en-US"/><a:t>${escapeXml(text)}</a:t></a:fld>`;
/** An inline equation: a14:m inside an AlternateContent with a plain-run fallback, as PowerPoint writes it. */
export const math = (fallbackText = 'x'): string =>
  `<mc:AlternateContent><mc:Choice Requires="a14"><a14:m><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback>${run(fallbackText)}</mc:Fallback></mc:AlternateContent>`;
/** A paragraph; a bare string becomes a single run. */
export const para = (parts: string[] | string, opts: { rtl?: boolean } = {}): string =>
  `<a:p>${opts.rtl ? '<a:pPr rtl="1"/>' : ''}${typeof parts === 'string' ? run(parts) : parts.join('')}</a:p>`;

const xfrm = (b: TinyBox, tag = 'a:xfrm'): string =>
  `<${tag}><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></${tag}>`;

export const sp = (
  paras: string[],
  opts: { box?: TinyBox; ph?: { type?: string; idx?: number }; hidden?: boolean; name?: string } = {},
): string => {
  const ph = opts.ph
    ? `<p:ph${opts.ph.type ? ` type="${opts.ph.type}"` : ''}${opts.ph.idx !== undefined ? ` idx="${opts.ph.idx}"` : ''}/>`
    : '';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${escapeXml(opts.name ?? 'Shape')}"${opts.hidden ? ' hidden="1"' : ''}/>` +
    `<p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${opts.box ? xfrm(opts.box) : ''}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`
  );
};

/** A table; cells listed in `merged` (0-based [row, col]) are written as hMerge continuation cells. */
export const table = (
  rows: string[][],
  box: TinyBox,
  opts: { merged?: [row: number, col: number][] } = {},
): string => {
  const merged = new Set((opts.merged ?? []).map(([r, c]) => `${r},${c}`));
  const trs = rows
    .map(
      (cells, r) =>
        `<a:tr h="370840">${cells
          .map(
            (t, c) =>
              `<a:tc${merged.has(`${r},${c}`) ? ' hMerge="1"' : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${para(t)}</a:txBody></a:tc>`,
          )
          .join('')}</a:tr>`,
    )
    .join('');
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(box, 'p:xfrm')}<a:graphic><a:graphicData uri="${NS_A}/table"><a:tbl><a:tblPr/><a:tblGrid/>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
};

export const group = (
  shapes: string[],
  g: { off: [number, number]; ext: [number, number]; chOff: [number, number]; chExt: [number, number] },
): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>` +
  `<a:off x="${g.off[0]}" y="${g.off[1]}"/><a:ext cx="${g.ext[0]}" cy="${g.ext[1]}"/>` +
  `<a:chOff x="${g.chOff[0]}" y="${g.chOff[1]}"/><a:chExt cx="${g.chExt[0]}" cy="${g.chExt[1]}"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:grpSp>`;

export const pic = (box: TinyBox): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>` +
  `<p:spPr>${xfrm(box)}</p:spPr></p:pic>`;

export const graphicFrame = (uriSuffix: 'chart' | 'diagram', box: TinyBox): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Frame"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `${xfrm(box, 'p:xfrm')}<a:graphic><a:graphicData uri="${NS_A}/${uriSuffix}"/></a:graphic></p:graphicFrame>`;

/** A whole slide part around the given shapes. */
export const slideXml = (shapes: string[], opts: { show?: boolean } = {}): string =>
  `${DECL}<p:sld ${ROOT_NS}${opts.show === false ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

export interface TinySlide {
  shapes?: string[];
  /** A whole slide part; overrides `shapes`. */
  xml?: string;
  show?: boolean;
}

export interface TinyPptxOptions {
  /** `null` leaves p:sldSz out. Default 12192000 x 6858000. */
  slideSize?: { cx: number; cy: number } | null;
  /** sldIdLst order as 1-based slide file numbers (default 1..n). */
  order?: number[];
  /** Write Target="/ppt/slides/slideN.xml" instead of a relative target. */
  absoluteTargets?: boolean;
  /** Replacement layout / master part XML. */
  layout?: string;
  master?: string;
  /** Extra or replacement entries, e.g. a corrupt slide. */
  extra?: Record<string, string | Uint8Array>;
  /** Entry names to leave out. */
  omit?: string[];
}

const box = (x: number, y: number, cx: number, cy: number): TinyBox => ({ x, y, cx, cy });
const TITLE_BOX = box(838200, 365125, 10515600, 1325563);
const BODY_BOX = box(838200, 1825625, 10515600, 4351338);

const phShape = (type: string | undefined, idx: number | undefined, b: TinyBox, name: string): string =>
  sp([para('Placeholder text')], { ph: { type, idx }, box: b, name });
const tree = (shapes: string[]): string =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld>`;

const DEFAULT_LAYOUT = `${DECL}<p:sldLayout ${ROOT_NS}>${tree([
  phShape('title', undefined, TITLE_BOX, 'Title'),
  phShape(undefined, 1, BODY_BOX, 'Body'),
])}</p:sldLayout>`;
const DEFAULT_MASTER = `${DECL}<p:sldMaster ${ROOT_NS}>${tree([
  phShape('title', undefined, TITLE_BOX, 'Title'),
  phShape('body', undefined, BODY_BOX, 'Body'),
  phShape('dt', 2, box(838200, 6356350, 2743200, 365125), 'Date'),
  phShape('ftr', 3, box(4038600, 6356350, 4114800, 365125), 'Footer'),
  phShape('sldNum', 4, box(8610600, 6356350, 2743200, 365125), 'Slide number'),
])}</p:sldMaster>`;

const rel = (id: string, type: string, target: string, external = false): string =>
  `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`;
const rels = (items: string[]): string =>
  `${DECL}<Relationships xmlns="${NS_REL}">${items.join('')}</Relationships>`;

/** Builds a PPTX package. Slides are files slide1..slideN; `order` decides their presentation order. */
export function tinyPptx(slides: TinySlide[], opts: TinyPptxOptions = {}): Uint8Array {
  const n = slides.length;
  const order = opts.order ?? slides.map((_, i) => i + 1);
  const size = opts.slideSize === undefined ? { cx: 12192000, cy: 6858000 } : opts.slideSize;
  const target = (i: number) => (opts.absoluteTargets ? `/ppt/slides/slide${i}.xml` : `slides/slide${i}.xml`);

  const presentation =
    `${DECL}<p:presentation ${ROOT_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${order.map((fileNo, pos) => `<p:sldId id="${256 + pos}" r:id="rId${fileNo}"/>`).join('')}</p:sldIdLst>` +
    `${size ? `<p:sldSz cx="${size.cx}" cy="${size.cy}"/>` : ''}</p:presentation>`;

  const files: Record<string, string> = {
    '[Content_Types].xml':
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '</Types>',
    '_rels/.rels': rels([rel('rId1', 'officeDocument', 'ppt/presentation.xml')]),
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': rels([
      ...slides.map((_, i) => rel(`rId${i + 1}`, 'slide', target(i + 1))),
      rel('rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel('rIdX', 'hyperlink', 'https://example.invalid/', true),
    ]),
    'ppt/slideLayouts/slideLayout1.xml': opts.layout ?? DEFAULT_LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
      rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'),
    ]),
    'ppt/slideMasters/slideMaster1.xml': opts.master ?? DEFAULT_MASTER,
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = s.xml ?? slideXml(s.shapes ?? [], { show: s.show });
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([
      rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
    ]);
  });

  const entries: Record<string, string | Uint8Array> = { ...files, ...opts.extra };
  for (const name of opts.omit ?? []) delete entries[name];
  return zipBytes(entries);
}
