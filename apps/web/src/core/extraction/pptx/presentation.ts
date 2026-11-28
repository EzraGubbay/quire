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
const isTrue = (v: string | undefined): boolean => v === '1' || v === 'true';

const ROOT_TAG = /^[\s\S]*?<p:sld(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/;
const SHOW_ATTR = /\sshow\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Whether a slide is hidden, from its root start tag alone. Slides are not parsed here: parsed XML costs about
 * 70x its size in heap, so a deck's slides are parsed one at a time, on demand, through `part`. Anything that
 * does not look like a plain p:sld root is parsed in full so it fails with the right typed error.
 */
function slideIsHidden(zip: Map<string, Uint8Array>, name: string): boolean {
  const data = zip.get(name);
  if (!data) throw new PptxError('missing_part', `part ${name} is not in the package`, name);
  const text = decodePart(data, name);
  const tag = ROOT_TAG.exec(text.slice(0, 4096));
  if (!tag) {
    const root = parseXml(text, name);
    throw new PptxError('unsupported', `unexpected root element ${root.name} in ${name}`, name);
  }
  const show = SHOW_ATTR.exec(tag[1] ?? '');
  const value = show?.[1] ?? show?.[2];
  return value === '0' || value === 'false';
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
  for (const id of children(
    child(presentation, 'p:sldIdLst') ?? { name: '', attrs: {}, children: [] },
    'p:sldId',
  )) {
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
