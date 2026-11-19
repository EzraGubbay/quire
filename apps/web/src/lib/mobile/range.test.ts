import { describe, expect, it } from 'vitest';
import { etagFor, ifNoneMatchHits, ifRangeAllows, parseRange } from './range';

describe('parseRange', () => {
  it('no header → none', () => expect(parseRange(null, 100)).toEqual({ kind: 'none' }));
  it('closed range', () =>
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'range', start: 0, end: 99 }));
  it('open-ended range runs to EOF', () =>
    expect(parseRange('bytes=900-', 1000)).toEqual({ kind: 'range', start: 900, end: 999 }));
  it('suffix range is the last N bytes', () =>
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'range', start: 900, end: 999 }));
  it('suffix larger than file returns the whole file', () =>
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'range', start: 0, end: 999 }));
  it('end past EOF is clamped', () =>
    expect(parseRange('bytes=10-5000', 1000)).toEqual({ kind: 'range', start: 10, end: 999 }));
  it('start at/after EOF is unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=99999999-100000000', 1000)).toEqual({ kind: 'unsatisfiable' });
  });
  it('zero-length suffix is unsatisfiable', () =>
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' }));
  it('zero-length file: every range is unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });
  it('malformed or non-bytes headers are ignored (full body)', () => {
    for (const h of ['bytes=', 'bytes=abc', 'bytes=5-2', 'bytes=-', 'items=0-5', 'garbage', 'bytes=1-2-3'])
      expect(parseRange(h, 1000)).toEqual({ kind: 'none' });
  });
  it('multi-range falls back to full body', () =>
    expect(parseRange('bytes=0-1,5-9', 1000)).toEqual({ kind: 'none' }));
});

describe('etagFor', () => {
  it('is strong (no W/ prefix), quoted, and varies with size and mtime', () => {
    const a = etagFor(10, 1000);
    expect(a).toMatch(/^"[^"]+"$/);
    expect(a).not.toMatch(/^W\//);
    expect(a).toBe(etagFor(10, 1000));
    expect(a).not.toBe(etagFor(11, 1000));
    expect(a).not.toBe(etagFor(10, 1001));
  });
});

describe('ifNoneMatchHits', () => {
  const e = '"abc"';
  it('matches exact, list, weak-prefixed and *', () => {
    expect(ifNoneMatchHits('"abc"', e)).toBe(true);
    expect(ifNoneMatchHits('"x", "abc"', e)).toBe(true);
    expect(ifNoneMatchHits('W/"abc"', e)).toBe(true);
    expect(ifNoneMatchHits('*', e)).toBe(true);
  });
  it('misses otherwise', () => {
    expect(ifNoneMatchHits(null, e)).toBe(false);
    expect(ifNoneMatchHits('"zzz"', e)).toBe(false);
  });
});

describe('ifRangeAllows', () => {
  const e = '"abc"';
  it('absent → range honoured', () => expect(ifRangeAllows(null, e)).toBe(true));
  it('matching strong etag → honoured', () => expect(ifRangeAllows('"abc"', e)).toBe(true));
  it('stale etag → restart with full body', () => expect(ifRangeAllows('"old"', e)).toBe(false));
  it('weak etag or date → not honoured', () => {
    expect(ifRangeAllows('W/"abc"', e)).toBe(false);
    expect(ifRangeAllows('Wed, 21 Oct 2026 07:28:00 GMT', e)).toBe(false);
  });
});
