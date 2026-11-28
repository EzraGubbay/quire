import { openPptx, type PptxPackage, type SlideRef, type SlideSize } from './presentation';
import { type LayoutCache, readSlide, relsPartOf, type SlideText } from './slide';
import type { ZipLimits } from './zip';

/** `page_extractions.extractor` value for text read from a PPTX package. */
export const PPTX_EXTRACTOR = 'pptx-v1';
/** Bump on any change to the reader's output. */
export const PPTX_READER_VERSION = 1;

export interface PptxSlide extends SlideRef, SlideText {}
export interface PptxText {
  slides: PptxSlide[];
  visibleCount: number;
  hiddenCount: number;
  slideSize: SlideSize;
}

/**
 * One slide at a time, in presentation order, hidden slides included (empty text). Each slide is parsed, read
 * and released before it is yielded, so nothing slide-sized stays alive while the consumer waits (a caller can
 * await between slides). A visible slide that cannot be read throws: never mix partial PPTX text with another
 * extractor.
 */
export function* pptxSlides(pkg: PptxPackage): Generator<PptxSlide, void, undefined> {
  const layouts: LayoutCache = new Map();
  for (const ref of pkg.slides) {
    let st: SlideText;
    try {
      st = readSlide(pkg, ref, layouts);
    } finally {
      pkg.release(ref.part);
      pkg.release(relsPartOf(ref.part));
    }
    yield { ...ref, ...st };
  }
}

export function readPptx(bytes: Uint8Array, limits?: ZipLimits): PptxText {
  const pkg = openPptx(bytes, limits);
  return {
    slides: [...pptxSlides(pkg)],
    visibleCount: pkg.visibleCount,
    hiddenCount: pkg.hiddenCount,
    slideSize: pkg.slideSize,
  };
}

export { PptxError, type PptxErrorCode } from './errors';
export { MATH_PLACEHOLDER } from './paragraph';
export { openPptx, type PptxPackage, type SlideRef, type SlideSize } from './presentation';
export { ROW_TOLERANCE, type SlideFlags, type SlideText } from './slide';
export { DEFAULT_ZIP_LIMITS, type ZipLimits } from './zip';
