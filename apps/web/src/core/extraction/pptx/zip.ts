import { inflateRawSync } from 'node:zlib';
import { PptxError } from './errors';

export interface ZipLimits {
  /** Declared uncompressed size of one wanted entry. */
  maxEntryBytes: number;
  /** Sum of the declared uncompressed sizes of the wanted entries. */
  maxTotalBytes: number;
  /** Central-directory entries, wanted or not. */
  maxEntries: number;
  /** originalSize / compressedSize of a wanted entry, checked only when originalSize exceeds ratioMinBytes. */
  maxRatio: number;
  ratioMinBytes: number;
}

// Slide XML is tiny; parsed XML costs roughly 70x its size in heap, so the defaults stay well below what a
// shared Pi can parse in one go.
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntries: 10_000,
  maxRatio: 200,
  ratioMinBytes: 1024 * 1024,
};

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const U32_MAX = 0xffffffff;

/** Names a well-formed package never uses; they are ignored (never inflated), not an error. */
function isOddName(name: string): boolean {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.endsWith('/')) return true;
  return name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

interface Directory {
  count: number;
  offset: number;
  size: number;
}

/** Locates the central directory. The entry count is checked against the cap before anything iterates. */
function readDirectory(bytes: Uint8Array, view: DataView, limits: ZipLimits): Directory {
  const notZip = () => new PptxError('not_zip', 'corrupt zip archive');
  let eocd = -1;
  for (let i = bytes.length - EOCD_SIZE; i >= Math.max(0, bytes.length - EOCD_SIZE - 0xffff); i--) {
    if (
      view.getUint32(i, true) === SIG_EOCD &&
      i + EOCD_SIZE + view.getUint16(i + 20, true) <= bytes.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();

  let count = BigInt(view.getUint16(eocd + 10, true));
  let size = BigInt(view.getUint32(eocd + 12, true));
  let offset = BigInt(view.getUint32(eocd + 16, true));
  if (count === 0xffffn || size === BigInt(U32_MAX) || offset === BigInt(U32_MAX)) {
    const loc = eocd - 20;
    if (loc < 0 || view.getUint32(loc, true) !== SIG_LOCATOR64) throw notZip();
    const at = view.getBigUint64(loc + 8, true);
    if (at > BigInt(bytes.length - 56)) throw notZip();
    const z = Number(at);
    if (view.getUint32(z, true) !== SIG_EOCD64) throw notZip();
    count = view.getBigUint64(z + 32, true);
    size = view.getBigUint64(z + 40, true);
    offset = view.getBigUint64(z + 48, true);
  }
  if (count > BigInt(limits.maxEntries)) {
    throw new PptxError('zip_limits', `more than ${limits.maxEntries} zip entries`);
  }
  if (offset + size > BigInt(bytes.length) || count * BigInt(CENTRAL_SIZE) > size) throw notZip();
  return { count: Number(count), offset: Number(offset), size: Number(size) };
}

/**
 * Inflates only the entries `want` accepts, in memory. The central directory is walked here, not by a zip
 * library: the entry count is capped before iterating, every wanted entry is read from its own local header,
 * entries whose byte ranges overlap are rejected (so one stored entry cannot be counted many times), and
 * inflation stops at the declared size (so CPU and memory are bounded by the caps). Throws PptxError.
 */
export function readZip(
  bytes: Uint8Array,
  want: (name: string) => boolean,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  if (CFB_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new PptxError('encrypted', 'OLE compound file: password-protected or legacy PowerPoint file');
  }
  if (bytes.length < EOCD_SIZE || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new PptxError('not_zip', 'not a zip archive');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dir = readDirectory(bytes, view, limits);
  const corrupt = (why: string) => new PptxError('not_zip', `corrupt zip archive: ${why}`);
  const utf8 = new TextDecoder('utf-8');

  interface Wanted {
    name: string;
    method: number;
    compressed: number;
    original: number;
    local: number;
  }
  const wanted: Wanted[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = dir.offset;
  const end = dir.offset + dir.size;
  for (let i = 0; i < dir.count; i++) {
    if (pos + CENTRAL_SIZE > end || view.getUint32(pos, true) !== SIG_CENTRAL)
      throw corrupt('central directory');
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true);
    const original = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const next =
      pos + CENTRAL_SIZE + nameLen + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    if (next > end) throw corrupt('central directory entry');
    const name = utf8.decode(bytes.subarray(pos + CENTRAL_SIZE, pos + CENTRAL_SIZE + nameLen));
    const local = view.getUint32(pos + 42, true);
    pos = next;
    if (isOddName(name) || !want(name)) continue;

    if (seen.has(name)) throw new PptxError('zip_entry', `duplicate zip entry ${name}`, name);
    seen.add(name);
    if (flags & 1) throw new PptxError('encrypted', `entry ${name} is encrypted`, name);
    if (compressed === U32_MAX || original === U32_MAX || local === U32_MAX) {
      throw new PptxError(
        'zip_limits',
        `entry ${name} uses zip64 sizes, beyond the ${limits.maxEntryBytes} byte cap`,
        name,
      );
    }
    if (original > limits.maxEntryBytes) {
      throw new PptxError(
        'zip_limits',
        `entry ${name} is ${original} bytes, cap is ${limits.maxEntryBytes}`,
        name,
      );
    }
    total += original;
    if (total > limits.maxTotalBytes) {
      throw new PptxError(
        'zip_limits',
        `entries exceed ${limits.maxTotalBytes} bytes in total (at ${name})`,
        name,
      );
    }
    if (original > limits.ratioMinBytes && (compressed === 0 || original / compressed > limits.maxRatio)) {
      throw new PptxError('zip_limits', `entry ${name} compresses more than ${limits.maxRatio}:1`, name);
    }
    wanted.push({ name, method, compressed, original, local });
  }

  // Each wanted entry owns [local header, end of its data]. Overlap means one stored entry is counted many times.
  const ranges: { name: string; from: number; to: number }[] = [];
  const out = new Map<string, Uint8Array>();
  const starts = new Map<string, number>();
  let compressedTotal = 0;
  for (const w of wanted) {
    if (w.local + LOCAL_SIZE > bytes.length || view.getUint32(w.local, true) !== SIG_LOCAL) {
      throw corrupt(`local header of ${w.name}`);
    }
    const nameLen = view.getUint16(w.local + 26, true);
    const start = w.local + LOCAL_SIZE + nameLen + view.getUint16(w.local + 28, true);
    if (start + w.compressed > bytes.length) throw corrupt(`data of ${w.name}`);
    if (utf8.decode(bytes.subarray(w.local + LOCAL_SIZE, w.local + LOCAL_SIZE + nameLen)) !== w.name) {
      throw new PptxError('zip_entry', `local header name differs from the directory for ${w.name}`, w.name);
    }
    compressedTotal += w.compressed;
    ranges.push({ name: w.name, from: w.local, to: start + w.compressed });
    starts.set(w.name, start);
  }
  if (compressedTotal > bytes.length)
    throw new PptxError('zip_limits', 'entries claim more data than the archive holds');
  ranges.sort((a, b) => a.from - b.from);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    if (prev && cur && cur.from < prev.to) {
      throw new PptxError('zip_entry', `entries ${prev.name} and ${cur.name} overlap`, cur.name);
    }
  }

  for (const w of wanted) {
    const start = starts.get(w.name) ?? 0;
    const data = bytes.subarray(start, start + w.compressed);
    if (w.method === 0) {
      if (w.compressed !== w.original) {
        throw new PptxError('zip_entry', `stored entry ${w.name} has mismatched sizes`, w.name);
      }
      out.set(w.name, data.slice());
    } else if (w.method === 8) {
      let inflated: Uint8Array;
      try {
        // Output is capped at the declared size, so a lying directory costs at most that much work.
        inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, w.original) });
      } catch {
        throw new PptxError(
          'zip_entry',
          `entry ${w.name} does not inflate to its declared ${w.original} bytes`,
          w.name,
        );
      }
      if (inflated.length !== w.original) {
        throw new PptxError(
          'zip_entry',
          `entry ${w.name} inflates to ${inflated.length} bytes, not ${w.original}`,
          w.name,
        );
      }
      out.set(w.name, new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.length));
    } else {
      throw new PptxError('zip_entry', `unsupported compression method ${w.method} on ${w.name}`, w.name);
    }
  }
  return out;
}
