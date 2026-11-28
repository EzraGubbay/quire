// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PptxError } from './errors';
import { child, children, decodeEntities, decodePart, parseXml, path } from './xml';

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const parse = (body: string) => parseXml(`<a:p ${A}>${body}</a:p>`, 'ppt/x.xml');
const codeOf = (fn: () => unknown): PptxError | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PptxError);
    return e as PptxError;
  }
  return undefined;
};

describe('parseXml', () => {
  it('X1 keeps mixed children in document order', () => {
    const p = parse(
      '<a:r><a:t>1</a:t></a:r><a:br/><a:fld type="x"><a:t>2</a:t></a:fld><a:r><a:t>3</a:t></a:r>',
    );
    expect(p.children.map((c) => c.name)).toEqual(['a:r', 'a:br', 'a:fld', 'a:r']);
    expect(children(p, 'a:r')).toHaveLength(2);
    expect(child(p, 'a:fld')?.attrs.type).toBe('x');
  });

  it('X2 does not trim text', () => {
    const p = parse('<a:r><a:t> </a:t></a:r><a:r><a:t>  a  </a:t></a:r>');
    const texts = children(p, 'a:r').map((r) => path(r, 'a:t')?.children[0]?.text);
    expect(texts).toEqual([' ', '  a  ']);
  });

  it('X3 keeps numeric-looking text as strings', () => {
    const p = parse('<a:r><a:t>007</a:t></a:r><a:r><a:t>10</a:t></a:r>');
    const texts = children(p, 'a:r').map((r) => path(r, 'a:t')?.children[0]?.text);
    expect(texts).toEqual(['007', '10']);
  });

  it('X4 decodes predefined and numeric entities in text and attributes', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'');
    expect(decodeEntities('&#x5D0;&#1488;')).toBe('אא');
    expect(decodeEntities('&nbsp;')).toBe('&nbsp;');
    expect(decodeEntities('a&#0;b&#xD800;c&#x110000;d')).toBe('abcd');
    const p = parse('<a:r a="&lt;&#x5D0;"><a:t>x &amp;&amp; y</a:t></a:r>');
    const r = child(p, 'a:r');
    expect(r?.attrs.a).toBe('<א');
    expect(path(r as never, 'a:t')?.children[0]?.text).toBe('x && y');
  });

  it('X5 rejects a DOCTYPE and never expands its entities', () => {
    const err = codeOf(() => parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><a>&e;</a>', 'ppt/x.xml'));
    expect(err?.code).toBe('malformed_xml');
    expect(err?.message).toContain('DTD');
    expect(err?.message).not.toContain('boom');
  });

  it.each(['<a><b></a>', 'not xml', '<a>'])(
    'X6 rejects lenient-parser input %j with the part name',
    (xml) => {
      const err = codeOf(() => parseXml(xml, 'ppt/slides/slide1.xml'));
      expect(err?.code).toBe('malformed_xml');
      expect(err?.part).toBe('ppt/slides/slide1.xml');
    },
  );

  it('X7 rejects 150-deep nesting', () => {
    const xml = `${'<a>'.repeat(150)}${'</a>'.repeat(150)}`;
    expect(codeOf(() => parseXml(xml, 'ppt/x.xml'))?.code).toBe('malformed_xml');
  });

  it('X8 rejects a __proto__ element without touching Object.prototype', () => {
    expect(codeOf(() => parseXml('<__proto__/>', 'ppt/x.xml'))?.code).toBe('malformed_xml');
    expect(codeOf(() => parseXml('<a __proto__="1"><__proto__>x</__proto__></a>', 'ppt/x.xml'))?.code).toBe(
      'malformed_xml',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('X10 returns CDATA content as unescaped text', () => {
    const p = parse('<a:r><a:t><![CDATA[a<b]]></a:t></a:r>');
    expect(path(p, 'a:r', 'a:t')?.children[0]?.text).toBe('a<b');
  });
});

describe('decodePart', () => {
  it('X9 handles BOMs and rejects invalid UTF-8', () => {
    const enc = new TextEncoder();
    expect(decodePart(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode('<a/>')]), 'p')).toBe('<a/>');
    const le = [0xff, 0xfe, ...[...'<a/>'].flatMap((c) => [c.charCodeAt(0), 0])];
    expect(decodePart(Uint8Array.from(le), 'p')).toBe('<a/>');
    const be = [0xfe, 0xff, ...[...'<a/>'].flatMap((c) => [0, c.charCodeAt(0)])];
    expect(decodePart(Uint8Array.from(be), 'p')).toBe('<a/>');
    const err = codeOf(() => decodePart(Uint8Array.from([0xc3, 0x28]), 'ppt/x.xml'));
    expect(err?.code).toBe('malformed_xml');
    expect(err?.part).toBe('ppt/x.xml');
  });
});
