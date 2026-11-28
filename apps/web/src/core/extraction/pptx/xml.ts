import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PptxError } from './errors';

/** An element or text node of a parsed OOXML part. Text nodes are named '#text' with `text` set. */
export interface XNode {
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: XNode[];
  text?: string;
}

// preserveOrder keeps mixed children (runs, breaks, fields) in document order. Values stay strings and
// whitespace is kept (`<a:t> </a:t>` and `007` are real text). processEntities is off, so no DOCTYPE entity
// table can ever be applied; decodeEntities below handles the five predefined and numeric references.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * Decodes the five predefined entities and numeric character references. Unknown named entities stay literal;
 * references to code points that are not XML characters are dropped.
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(
    /&(?:#x([0-9a-fA-F]{1,8})|#([0-9]{1,9})|(lt|gt|amp|quot|apos));/g,
    (_m, hex, dec, name) => {
      if (name) return NAMED[name] ?? '';
      const cp = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
      return isXmlChar(cp) ? String.fromCodePoint(cp) : '';
    },
  );
}

/** Text of a part: UTF-8 (with or without BOM) or UTF-16 with a BOM; anything else invalid is malformed_xml. */
export function decodePart(bytes: Uint8Array, part: string): string {
  let label = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new PptxError('malformed_xml', `${part} is not valid ${label} text`, part);
  }
}

type RawNode = Record<string, unknown>;

function normalize(raw: RawNode): XNode | undefined {
  if (typeof raw['#text'] === 'string') {
    return { name: '#text', attrs: {}, children: [], text: decodeEntities(raw['#text']) };
  }
  const name = Object.keys(raw).find((k) => k !== ':@');
  if (name === undefined) return undefined;
  const attrs: Record<string, string> = Object.create(null);
  const rawAttrs = raw[':@'];
  if (rawAttrs && typeof rawAttrs === 'object') {
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = decodeEntities(String(v));
  }
  const kids = Array.isArray(raw[name]) ? (raw[name] as RawNode[]) : [];
  const children: XNode[] = [];
  for (const k of kids) {
    const n = normalize(k);
    if (n) children.push(n);
  }
  return { name, attrs, children };
}

/** Validates, then parses, one XML part into its document element. Throws PptxError('malformed_xml'). */
export function parseXml(xml: string, part: string): XNode {
  const bad = (why: string) => new PptxError('malformed_xml', `${part}: ${why}`, part);
  if (xml.includes('<!DOCTYPE')) throw bad('DTD not allowed');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw bad(valid.err.msg);
  let tree: unknown;
  try {
    tree = parser.parse(xml);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : 'parse failed');
  }
  for (const raw of Array.isArray(tree) ? (tree as RawNode[]) : []) {
    if (typeof raw['#text'] === 'string') continue;
    const n = normalize(raw);
    if (n) return n;
  }
  throw bad('no document element');
}

export const child = (n: XNode, name: string): XNode | undefined => n.children.find((c) => c.name === name);
export const children = (n: XNode, name: string): XNode[] => n.children.filter((c) => c.name === name);

/** Follows a chain of first-child names: path(n, 'a', 'b') is child(child(n, 'a'), 'b'). */
export function path(n: XNode, ...names: string[]): XNode | undefined {
  let cur: XNode | undefined = n;
  for (const name of names) {
    if (!cur) return undefined;
    cur = child(cur, name);
  }
  return cur;
}
