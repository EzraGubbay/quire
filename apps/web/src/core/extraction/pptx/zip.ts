import { unzipSync } from 'fflate';
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

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
  maxRatio: 200,
  ratioMinBytes: 1024 * 1024,
};

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Names a well-formed package never uses; they are ignored (never inflated), not an error. */
function isOddName(name: string): boolean {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.endsWith('/')) return true;
  return name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Inflates only the entries `want` accepts, in memory. fflate hands each central-directory entry to the filter
 * before inflating, so unwanted entries (media) are never decompressed, and a wanted entry is inflated into a
 * buffer of its declared size, so a capped declared size caps real memory. Throws PptxError.
 */
export function readZip(
  bytes: Uint8Array,
  want: (name: string) => boolean,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  if (CFB_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new PptxError('encrypted', 'OLE compound file: password-protected or legacy PowerPoint file');
  }
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new PptxError('not_zip', 'not a zip archive');
  }

  let entries = 0;
  let total = 0;
  const seen = new Set<string>();
  let failure: PptxError | undefined;
  const fail = (code: 'zip_limits' | 'zip_entry', message: string, part: string): false => {
    failure ??= new PptxError(code, message, part);
    return false;
  };

  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(bytes, {
      filter: ({ name, size, originalSize }) => {
        if (failure) return false;
        if (++entries > limits.maxEntries)
          return fail('zip_limits', `more than ${limits.maxEntries} zip entries`, name);
        if (isOddName(name) || !want(name)) return false;
        if (seen.has(name)) return fail('zip_entry', `duplicate zip entry ${name}`, name);
        seen.add(name);
        if (originalSize > limits.maxEntryBytes) {
          return fail(
            'zip_limits',
            `entry ${name} is ${originalSize} bytes, cap is ${limits.maxEntryBytes}`,
            name,
          );
        }
        total += originalSize;
        if (total > limits.maxTotalBytes) {
          return fail(
            'zip_limits',
            `entries exceed ${limits.maxTotalBytes} bytes in total (at ${name})`,
            name,
          );
        }
        if (originalSize > limits.ratioMinBytes && (size === 0 || originalSize / size > limits.maxRatio)) {
          return fail('zip_limits', `entry ${name} compresses more than ${limits.maxRatio}:1`, name);
        }
        return true;
      },
    });
  } catch (e) {
    if (failure) throw failure;
    const code = (e as { code?: number }).code;
    if (code === 14) throw new PptxError('zip_entry', 'unsupported compression method on a wanted entry');
    throw new PptxError('not_zip', 'corrupt zip archive');
  }
  if (failure) throw failure;
  return new Map(Object.entries(out));
}
