import { PptxError } from './errors';
import { child, children, decodePart, parseXml, path, type XNode } from './xml';
import { DEFAULT_ZIP_LIMITS, readZip, type ZipLimits } from './zip';

/** Slide size in EMU. */
export interface SlideSize {
  cx: number;
  cy: number;
}

export interface Rel {
  id: string;
  type: string;
  /** Absolute part name such as 'ppt/slides/slide1.xml'. External relationships are dropped. */
  target: string;
}

export interface SlideRef {
  /** 1-based, presentation order (p:sldIdLst), hidden slides included. */
  index: number;
  /** 1-based page in the exported PDF (visible slides only); null when hidden. */
  page: number | null;
  /** Part name, e.g. 'ppt/slides/slide7.xml'. */
  part: string;
  /** `<p:sld show="0">` or `show="false"`. */
  hidden: boolean;
}

export interface PptxPackage {
  slideSize: SlideSize;
  slides: SlideRef[];
  visibleCount: number;
  hiddenCount: number;
  /** A parsed part, cached. A part that is not in the zip throws PptxError('missing_part'). */
  part(name: string): XNode;
  /** Drops a parsed part from the cache, e.g. a slide once it has been read. */
  release(name: string): void;
  /** Relationships of a part, by id. A part without a rels part has none. */
  rels(ofPart: string): Map<string, Rel>;
  /** First relationship of a part whose type ends with `typeSuffix`, e.g. '/slideLayout'. */
  relOfType(ofPart: string, typeSuffix: string): Rel | undefined;
}

const DEFAULT_SLIDE_SIZE: SlideSize = { cx: 9144000, cy: 6858000 };
const WANTED = /^ppt\/.+\.(xml|rels)$/;
/** More slides than any real deck; checked before any per-slide work. */
const MAX_SLIDES = 2000;
/** Enough for a prolog and the root start tag of any real slide; longer prologs fall back to the whole part. */
const PREFIX_BYTES = 8192;

type RootScan = { attrs: string } | 'other' | 'incomplete';

/**
 * Finds the root start tag of an XML text, skipping a BOM, whitespace, the declaration and comments. Returns
 * its attribute text for a p:sld root, 'other' for anything else, and 'incomplete' when the text ends first.
 */
function scanRoot(text: string): RootScan {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    const skip = text.startsWith('<?', i) ? ['?>', 2] : text.startsWith('<!--', i) ? ['-->', 4] : undefined;
    if (!skip) break;
    const end = text.indexOf(skip[0] as string, i + (skip[1] as number));
    if (end < 0) return 'incomplete';
    i = end + (skip[0] as string).length;
  }
  if (i >= text.length) return 'incomplete';
  if (text.charAt(i) !== '<' || text.startsWith('<!', i)) return 'other';
  const name = /^<([^\s/>]+)/.exec(text.slice(i, i + 256))?.[1];
  if (name !== 'p:sld') return 'other';
  let j = i + 1 + name.length;
  const attrsFrom = j;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '>') return { attrs: text.slice(attrsFrom, j) };
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, j + 1);
      if (close < 0) return 'incomplete';
      j = close;
    }
    j++;
  }
  return 'incomplete';
}

/**
 * Whether a slide is hidden, from its root start tag alone. Slides are not parsed here: parsed XML costs about
 * 70x its size in heap, so a deck's slides are parsed one at a time, on demand, through `part`. Only a bounded
 * prefix is decoded unless the prolog is longer than that; a root that is not p:sld is a typed error.
 */
function slideIsHidden(zip: Map<string, Uint8Array>, name: string): boolean {
  const data = zip.get(name);
  if (!data) throw new PptxError('missing_part', `part ${name} is not in the package`, name);
  const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
  const label = data[0] === 0xff ? 'utf-16le' : data[0] === 0xfe ? 'utf-16be' : 'utf-8';
  let scan = scanRoot(new TextDecoder(utf16 ? label : 'utf-8').decode(data.subarray(0, PREFIX_BYTES)));
  if (scan === 'incomplete' && data.length > PREFIX_BYTES) scan = scanRoot(decodePart(data, name));
  if (scan === 'other' || scan === 'incomplete') {
    // Surface malformed XML (or a DTD) with its own error; otherwise this is a well-formed non-slide root.
    const root = parseXml(decodePart(data, name), name);
    throw new PptxError('unsupported', `unexpected root element ${root.name} in ${name}`, name);
  }
  for (const m of scan.attrs.matchAll(/\s([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1] === 'show') return (m[2] ?? m[3]) === '0' || (m[2] ?? m[3]) === 'false';
  }
  return false;
}

/** Resolves a relationship target to an absolute part name; escaping the package root is missing_part. */
function resolveTarget(sourcePart: string, target: string): string {
  const bad = () =>
    new PptxError(
      'missing_part',
      `relationship target ${target} of ${sourcePart} is not a valid part`,
      sourcePart,
    );
  if (target.includes('\0') || target.includes('\\')) throw bad();
  const dir = sourcePart.split('/').slice(0, -1);
  const segments = target.startsWith('/') ? [] : dir;
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) throw bad();
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  if (segments.length === 0) throw bad();
  return segments.join('/');
}

export function openPptx(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): PptxPackage {
  const zip = readZip(bytes, (name) => WANTED.test(name), limits);
  if (!zip.has('ppt/presentation.xml'))
    throw new PptxError('not_pptx', 'no ppt/presentation.xml in the package');

  const parts = new Map<string, XNode>();
  const relsCache = new Map<string, Map<string, Rel>>();

  const part = (name: string): XNode => {
    const cached = parts.get(name);
    if (cached) return cached;
    const data = zip.get(name);
    if (!data) throw new PptxError('missing_part', `part ${name} is not in the package`, name);
    const node = parseXml(decodePart(data, name), name);
    parts.set(name, node);
    return node;
  };

  const rels = (ofPart: string): Map<string, Rel> => {
    const cached = relsCache.get(ofPart);
    if (cached) return cached;
    const slash = ofPart.lastIndexOf('/');
    const relsName = `${ofPart.slice(0, slash + 1)}_rels/${ofPart.slice(slash + 1)}.rels`;
    const out = new Map<string, Rel>();
    if (zip.has(relsName)) {
      for (const r of children(part(relsName), 'Relationship')) {
        const { Id: id, Type: type, Target: target, TargetMode: mode } = r.attrs;
        if (id === undefined || type === undefined || target === undefined || mode === 'External') continue;
        // A relationship that points outside the package is dropped, not fatal: only one that is needed fails.
        try {
          out.set(id, { id, type, target: resolveTarget(ofPart, target) });
        } catch (e) {
          if (!(e instanceof PptxError)) throw e;
        }
      }
    }
    relsCache.set(ofPart, out);
    return out;
  };

  const relOfType = (ofPart: string, typeSuffix: string): Rel | undefined =>
    [...rels(ofPart).values()].find((r) => r.type.endsWith(typeSuffix));

  const presentation = part('ppt/presentation.xml');
  if (presentation.name !== 'p:presentation') {
    throw new PptxError(
      'unsupported',
      `unexpected root element ${presentation.name} in ppt/presentation.xml`,
      'ppt/presentation.xml',
    );
  }

  const sz = path(presentation, 'p:sldSz');
  const cx = Number(sz?.attrs.cx);
  const cy = Number(sz?.attrs.cy);
  const slideSize = cx > 0 && cy > 0 ? { cx, cy } : DEFAULT_SLIDE_SIZE;

  const presentationRels = rels('ppt/presentation.xml');
  const slides: SlideRef[] = [];
  let page = 0;
  const ids = children(child(presentation, 'p:sldIdLst') ?? { name: '', attrs: {}, children: [] }, 'p:sldId');
  if (ids.length > MAX_SLIDES) {
    throw new PptxError(
      'unsupported',
      `${ids.length} slides, more than ${MAX_SLIDES}`,
      'ppt/presentation.xml',
    );
  }
  const listed = new Set<string>();
  for (const id of ids) {
    const rel = presentationRels.get(id.attrs['r:id'] ?? '');
    if (!rel)
      throw new PptxError(
        'missing_part',
        `slide id ${id.attrs.id ?? '?'} has no relationship`,
        'ppt/presentation.xml',
      );
    if (!rel.type.endsWith('/slide')) {
      throw new PptxError(
        'unsupported',
        `slide relationship ${rel.id} has type ${rel.type}`,
        'ppt/presentation.xml',
      );
    }
    if (listed.has(rel.target)) {
      throw new PptxError(
        'unsupported',
        `slide ${rel.target} is listed more than once`,
        'ppt/presentation.xml',
      );
    }
    listed.add(rel.target);
    const hidden = slideIsHidden(zip, rel.target);
    slides.push({ index: slides.length + 1, page: hidden ? null : ++page, part: rel.target, hidden });
  }

  const hiddenCount = slides.filter((s) => s.hidden).length;
  const release = (name: string): void => {
    parts.delete(name);
  };
  return {
    slideSize,
    slides,
    visibleCount: slides.length - hiddenCount,
    hiddenCount,
    part,
    release,
    rels,
    relOfType,
  };
}
