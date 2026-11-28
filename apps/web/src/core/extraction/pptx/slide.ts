import { PptxError } from './errors';
import { isRtl, mcBranch, paragraphText, tableText } from './paragraph';
import type { PptxPackage, SlideRef } from './presentation';
import { child, children, path, type XNode } from './xml';

/** Tops within this fraction of the slide height count as one row. */
export const ROW_TOLERANCE = 0.03;
/** Layout and master box indexes kept per deck read; the cache is cleared when it is full. */
export const MAX_CACHED_LAYOUTS = 32;

export interface SlideFlags {
  math: boolean;
  picture: boolean;
  chart: boolean;
  smartArt: boolean;
  table: boolean;
}
export interface SlideText {
  title?: string;
  text: string;
  flags: SlideFlags;
}
export const noFlags = (): SlideFlags => ({
  math: false,
  picture: false,
  chart: false,
  smartArt: false,
  table: false,
});

/** Slide coordinates in EMU. */
interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}
interface PhBox {
  idx?: string;
  cls: string;
  box?: Box;
}
export interface LayoutEntry {
  boxes: PhBox[];
  master?: string;
}
/** Keyed by layout or master part name. */
export type LayoutCache = Map<string, LayoutEntry>;

/** 'ppt/slides/slide1.xml' -> 'ppt/slides/_rels/slide1.xml.rels'. */
export const relsPartOf = (part: string): string => part.replace(/([^/]+)$/, '_rels/$1.rels');

/** X = a*x + b, Y = c*y + d. Group rotation and flips are ignored: only offset and scale are applied. */
interface Tx {
  a: number;
  b: number;
  c: number;
  d: number;
}
const IDENTITY: Tx = { a: 1, b: 0, c: 1, d: 0 };
const compose = (p: Tx, l: Tx): Tx => ({
  a: p.a * l.a,
  b: p.a * l.b + p.b,
  c: p.c * l.c,
  d: p.c * l.d + p.d,
});

interface Block {
  text: string;
  box?: Box;
  rtl: boolean;
  title: boolean;
  doc: number;
}
interface Ctx {
  cy: number;
  flags: SlideFlags;
  onMath: () => void;
  inherit: (ph: XNode) => Box | undefined;
}

/** Placeholder class used to match a slide placeholder with its layout or master. */
const phClass = (type: string | undefined): string =>
  type === 'title' || type === 'ctrTitle'
    ? 'title'
    : !type || type === 'body' || type === 'obj' || type === 'subTitle'
      ? 'body'
      : type;
const SKIPPED_PH = new Set(['sldNum', 'ftr', 'dt', 'hdr']);
const num = (s: string | undefined): number | undefined => {
  const v = s === undefined || s === '' ? Number.NaN : Number(s);
  return Number.isFinite(v) ? v : undefined;
};
const isHidden = (n: XNode): boolean => {
  const h = child(n.children.find((c) => c.name.startsWith('p:nv')) ?? n, 'p:cNvPr')?.attrs.hidden;
  return h === '1' || h === 'true';
};

/** off/ext of an xfrm element, or undefined when either is missing or not a finite number. */
function rawBox(x: XNode | undefined): Box | undefined {
  const off = x && child(x, 'a:off');
  const ext = x && child(x, 'a:ext');
  if (!off || !ext) return undefined;
  const [bx, by, cx, cy] = [num(off.attrs.x), num(off.attrs.y), num(ext.attrs.cx), num(ext.attrs.cy)];
  return bx === undefined || by === undefined || cx === undefined || cy === undefined
    ? undefined
    : { x: bx, y: by, cx, cy };
}
const mapBox = (b: Box | undefined, t: Tx): Box | undefined =>
  b && { x: t.a * b.x + t.b, y: t.c * b.y + t.d, cx: t.a * b.cx, cy: t.c * b.cy };

/** Local transform of a group: child space (chOff, chExt) onto the group's own off/ext. */
function groupLocal(x: XNode): Tx | undefined {
  const g = rawBox(x);
  const ch = child(x, 'a:chOff');
  const ce = child(x, 'a:chExt');
  const [x0, y0, ccx, ccy] = [num(ch?.attrs.x), num(ch?.attrs.y), num(ce?.attrs.cx), num(ce?.attrs.cy)];
  if (!g || x0 === undefined || y0 === undefined || ccx === undefined || ccy === undefined) return undefined;
  const sx = ccx > 0 ? g.cx / ccx : 1;
  const sy = ccy > 0 ? g.cy / ccy : 1;
  return { a: sx, b: g.x - x0 * sx, c: sy, d: g.y - y0 * sy };
}

function bodyText(body: XNode, ctx: Ctx): { text: string; rtl: boolean } {
  const paras = children(body, 'a:p').map((p) => ({ p, text: paragraphText(p, ctx.onMath) }));
  const lines = paras.filter((x) => x.text !== '');
  const first = lines[0];
  return { text: lines.map((x) => x.text).join('\n'), rtl: first ? isRtl(first.p, first.text) : false };
}

function walk(nodes: XNode[], t: Tx, top: boolean, ctx: Ctx): Block[] {
  const out: Block[] = [];
  const add = (text: string, box: Box | undefined, rtl = false, title = false) => {
    if (text !== '') out.push({ text, box, rtl, title, doc: 0 });
  };
  for (const n of nodes) {
    if (n.name === 'mc:AlternateContent') {
      out.push(...walk(mcBranch(n), t, top, ctx));
    } else if (n.name === 'p:pic') {
      if (!isHidden(n)) ctx.flags.picture = true;
    } else if (n.name === 'p:sp' && !isHidden(n)) {
      const ph = path(n, 'p:nvSpPr', 'p:nvPr', 'p:ph');
      const type = ph?.attrs.type;
      const body = child(n, 'p:txBody');
      if ((type && SKIPPED_PH.has(type)) || !body) continue;
      const { text, rtl } = bodyText(body, ctx);
      const own = rawBox(path(n, 'p:spPr', 'a:xfrm'));
      const box = own ? mapBox(own, t) : top && ph ? ctx.inherit(ph) : undefined;
      add(text, box, rtl, top && (type === 'title' || type === 'ctrTitle'));
    } else if (n.name === 'p:graphicFrame' && !isHidden(n)) {
      const data = path(n, 'a:graphic', 'a:graphicData');
      const uri = data?.attrs.uri ?? '';
      if (uri.endsWith('/table')) {
        ctx.flags.table = true;
        const tbl = data && child(data, 'a:tbl');
        add(tbl ? tableText(tbl, ctx.onMath) : '', mapBox(rawBox(child(n, 'p:xfrm')), t));
      } else if (uri.endsWith('/chart')) ctx.flags.chart = true;
      else if (uri.endsWith('/diagram')) ctx.flags.smartArt = true;
    } else if (n.name === 'p:grpSp' && !isHidden(n)) {
      const x = path(n, 'p:grpSpPr', 'a:xfrm');
      const local = x && groupLocal(x);
      const kids = orderBlocks(walk(n.children, local ? compose(t, local) : t, false, ctx), ctx.cy, false);
      const own = mapBox(rawBox(x), t);
      add(kids.map((k) => k.text).join('\n'), own ?? unionBox(kids), kids[0]?.rtl);
    }
  }
  return out;
}

function unionBox(blocks: Block[]): Box | undefined {
  const boxes = blocks.flatMap((b) => (b.box ? [b.box] : []));
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    cx: Math.max(...boxes.map((b) => b.x + b.cx)) - x,
    cy: Math.max(...boxes.map((b) => b.y + b.cy)) - y,
  };
}

/**
 * Reading order: titles first, then positioned blocks in rows (top to bottom; within a row left to right, or
 * right to left when every block of the row is RTL), then unpositioned blocks in document order.
 */
function orderBlocks(blocks: Block[], cy: number, useTitle: boolean): Block[] {
  blocks.forEach((b, i) => {
    b.doc = i;
  });
  const titles = useTitle ? blocks.filter((b) => b.title) : [];
  const rest = blocks.filter((b) => !titles.includes(b));
  const placed = rest
    .filter((b) => b.box)
    .sort((p, q) => (p.box?.y ?? 0) - (q.box?.y ?? 0) || (p.box?.x ?? 0) - (q.box?.x ?? 0) || p.doc - q.doc);
  const rows: Block[][] = [];
  let anchor = 0;
  for (const b of placed) {
    const top = b.box?.y ?? 0;
    const row = rows[rows.length - 1];
    if (row && top - anchor <= ROW_TOLERANCE * cy) row.push(b);
    else {
      rows.push([b]);
      anchor = top;
    }
  }
  const left = (b: Block) => b.box?.x ?? 0;
  const right = (b: Block) => (b.box?.x ?? 0) + (b.box?.cx ?? 0);
  const inRow = rows.flatMap((row) =>
    row.every((b) => b.rtl)
      ? row.sort((p, q) => right(q) - right(p) || p.doc - q.doc)
      : row.sort((p, q) => left(p) - left(q) || p.doc - q.doc),
  );
  return [...titles, ...inRow, ...rest.filter((b) => !b.box)];
}

/** Index of the top-level placeholders of a layout or master: only their boxes, never their text. */
function phIndex(root: XNode): PhBox[] {
  const out: PhBox[] = [];
  for (const sp of children(path(root, 'p:cSld', 'p:spTree') ?? root, 'p:sp')) {
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    if (!ph) continue;
    const type = ph.attrs.type;
    const cls = phClass(type);
    out.push({ idx: ph.attrs.idx, cls, box: rawBox(path(sp, 'p:spPr', 'a:xfrm')) });
  }
  return out;
}

/** Parses a layout or master, keeps only its small box index and releases the parsed part straight away. */
function entryOf(pkg: PptxPackage, part: string, layouts: LayoutCache, isLayout: boolean): LayoutEntry {
  const hit = layouts.get(part);
  if (hit) return hit;
  let entry: LayoutEntry;
  try {
    entry = {
      boxes: phIndex(pkg.part(part)),
      master: isLayout ? pkg.relOfType(part, '/slideMaster')?.target : undefined,
    };
  } finally {
    pkg.release(part);
    pkg.release(relsPartOf(part));
  }
  if (layouts.size >= MAX_CACHED_LAYOUTS) layouts.clear();
  layouts.set(part, entry);
  return entry;
}

/** Reads one visible slide. A hidden ref gives empty text without touching the part. */
export function readSlide(pkg: PptxPackage, ref: SlideRef, layouts: LayoutCache = new Map()): SlideText {
  const flags = noFlags();
  if (ref.hidden) return { text: '', flags };
  const root = pkg.part(ref.part);
  if (root.name !== 'p:sld')
    throw new PptxError('unsupported', `unexpected root element ${root.name}`, ref.part);
  if (root.attrs.show === '0' || root.attrs.show === 'false') {
    throw new PptxError('unsupported', `hidden state of ${ref.part} differs from its start tag`, ref.part);
  }
  const tree = path(root, 'p:cSld', 'p:spTree');
  if (!tree) return { text: '', flags };

  const inherit = (ph: XNode): Box | undefined => {
    const layoutPart = pkg.relOfType(ref.part, '/slideLayout')?.target;
    if (!layoutPart) return undefined;
    const layout = entryOf(pkg, layoutPart, layouts, true);
    const type = ph.attrs.type;
    const cls = phClass(type);
    const idx = ph.attrs.idx;
    const byIdx = idx === undefined ? undefined : layout.boxes.find((p) => p.idx === idx && p.box)?.box;
    const byCls = layout.boxes.find((p) => p.cls === cls && p.box)?.box;
    if (byIdx ?? byCls) return byIdx ?? byCls;
    return layout.master
      ? entryOf(pkg, layout.master, layouts, false).boxes.find((p) => p.cls === cls && p.box)?.box
      : undefined;
  };
  const ctx: Ctx = {
    cy: pkg.slideSize.cy,
    flags,
    onMath: () => {
      flags.math = true;
    },
    inherit,
  };
  const ordered = orderBlocks(walk(tree.children, IDENTITY, true, ctx), ctx.cy, true);
  const title = ordered
    .find((b) => b.title)
    ?.text.replace(/\s*\n\s*/g, ' ')
    .trim();
  return { ...(title ? { title } : {}), text: ordered.map((b) => b.text).join('\n\n'), flags };
}
