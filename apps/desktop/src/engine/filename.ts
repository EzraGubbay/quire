// Pure file-name decoding for Lemida downloads. No electron / node-html-parser imports so it loads
// under plain node (CI, node:test). Fetch header values are ByteStrings, so Moodle's raw UTF-8
// `filename="…"` arrives as UTF-8 bytes read as Latin-1 (Hebrew turns into mojibake).

/** Parse `;`-separated Content-Disposition params (first occurrence of each name wins). */
function parseParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  const first = header.indexOf(';');
  if (first < 0) return params;
  let i = first;
  const n = header.length;
  while (i < n) {
    while (i < n && (header[i] === ';' || header[i] === ' ' || header[i] === '\t')) i++;
    let nameEnd = i;
    while (nameEnd < n && header[nameEnd] !== '=' && header[nameEnd] !== ';') nameEnd++;
    const name = header.slice(i, nameEnd).trim().toLowerCase();
    i = nameEnd;
    if (i >= n || header[i] === ';') continue;
    i++; // '='
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i++;
    let value = '';
    if (header[i] === '"') {
      i++;
      while (i < n && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < n) i++;
        value += header[i];
        i++;
      }
      i++; // closing quote
      while (i < n && header[i] !== ';') i++;
    } else {
      const end = header.indexOf(';', i);
      const stop = end < 0 ? n : end;
      value = header.slice(i, stop).trim();
      i = stop;
    }
    if (name && !params.has(name)) params.set(name, value);
  }
  return params;
}

function decodeExtValue(value: string): string | undefined {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  const charset = (m?.[1] ?? '').toLowerCase();
  const encoded = m ? (m[2] ?? '') : value;
  try {
    if (charset === '' || charset === 'utf-8') return decodeURIComponent(encoded);
    if (charset === 'iso-8859-1') {
      return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_s, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  } catch {
    /* malformed */
  }
  return undefined;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/**
 * Undo UTF-8-read-as-Latin-1 mojibake: if every char is ≤ U+00FF, at least one is ≥ U+0080, and the
 * chars taken as bytes form valid UTF-8, return the UTF-8 decoding; otherwise return the input unchanged.
 */
export function repairLatin1Mojibake(s: string): string {
  let high = false;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s; // already real Unicode
    if (c >= 0x80) high = true;
    bytes[i] = c;
  }
  if (!high) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

/** The file name carried by a Content-Disposition header value, or undefined when it has none. */
export function parseContentDispositionFilename(header: string): string | undefined {
  const params = parseParams(header);
  const star = params.get('filename*');
  if (star !== undefined) {
    const decoded = decodeExtValue(star);
    if (decoded !== undefined && decoded.trim()) return decoded;
  }
  const plain = params.get('filename');
  if (plain === undefined) return undefined;
  let name = repairLatin1Mojibake(plain).trim();
  if (isAscii(name) && /%[0-9A-Fa-f]{2}/.test(name)) {
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep as is */
    }
  }
  return name || undefined;
}

/** A readable file name from a Content-Disposition header or, failing that, the URL's last segment. */
export function filenameFrom(url: string, contentDisposition?: string): string {
  if (contentDisposition) {
    const fromHeader = parseContentDispositionFilename(contentDisposition);
    if (fromHeader) return fromHeader;
  }
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (!seg) return 'file';
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  } catch {
    return 'file';
  }
}
