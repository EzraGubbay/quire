// Server-side fetch of a public https PDF for upload_pdf{url}, hardened against SSRF: the model (or text it
// read) chooses the URL, and this process sits next to a tailnet, a LAN and cloud-metadata-style addresses.
// Built on node:https so DNS can be pinned: the socket connects only to an address that was checked, so there
// is no resolve-then-connect gap for DNS rebinding. Redirects are followed by hand and re-checked per hop.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const envNum = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

export class FetchRefused extends Error {}

const PRIVATE_MSG =
  'That URL points to a private or local network address; only public https URLs can be fetched.';

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT: the tailnet
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4], // incl. 255.255.255.255
] as const) {
  blocked.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (::127.0.0.1)
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['fec0::', 10], // deprecated site-local
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96], // NAT64
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 can embed a v4 address
] as const) {
  blocked.addSubnet(a, p, 'ipv6');
}

/** True when `ip` is a loopback / private / link-local / CGNAT / metadata / reserved address. Pure. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(addr)) return blocked.check(addr, 'ipv4');
  if (!net.isIPv6(addr)) return true; // not an address at all: refuse
  // Canonicalize (0:0:0:0:0:ffff:7f00:1 -> ::ffff:7f00:1) so the mapped-address checks see one spelling.
  let v6 = addr;
  try {
    v6 = new URL(`https://[${addr}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v6);
  if (dotted?.[1]) return blocked.check(dotted[1], 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return blocked.check(v6, 'ipv6');
}

/** Parses and vets a URL before any network use. WHATWG parsing canonicalizes decimal/hex IPv4 hosts. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused('That is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new FetchRefused('Only https URLs can be fetched.');
  if (url.username || url.password) throw new FetchRefused('URLs with credentials are not allowed.');
  if (url.port !== '' && url.port !== '443')
    throw new FetchRefused('Only the default https port (443) is allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new FetchRefused(PRIVATE_MSG);
  return url;
}

export interface LookupAddress {
  address: string;
  family: number;
}
type LookupCb = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
export type GuardedLookup = (hostname: string, options: unknown, cb?: LookupCb) => void;

/** A dns.lookup replacement that refuses if ANY returned address is blocked, then pins the vetted ones. */
export function makeGuardedLookup(
  resolve: (host: string) => Promise<LookupAddress[]> = (h) => dns.promises.lookup(h, { all: true }),
): GuardedLookup {
  return (hostname, options, cb) => {
    const callback = (typeof options === 'function' ? options : cb) as LookupCb;
    const all =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    resolve(hostname).then(
      (addrs) => {
        const first = addrs[0];
        if (!first || addrs.some((a) => isBlockedAddress(a.address))) {
          callback(new FetchRefused(PRIVATE_MSG));
        } else if (all) {
          callback(null, addrs);
        } else {
          callback(null, first.address, first.family);
        }
      },
      () => callback(new FetchRefused('Could not resolve that host.')),
    );
  };
}

// The slice of http.IncomingMessage / ClientRequest this uses, so tests can fake them.
export interface FetchResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'end' | 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  destroy(err?: Error): unknown;
}
export interface FetchRequest {
  on(event: 'error', cb: (err: Error) => void): unknown;
  end(): unknown;
  destroy(err?: Error): unknown;
}
export type RequestFn = (
  url: URL,
  options: { lookup: GuardedLookup; headers: Record<string, string>; servername?: string },
  onResponse: (res: FetchResponse) => void,
) => FetchRequest;

const defaultRequest: RequestFn = (url, options, onResponse) =>
  // agent:false = a fresh, unpooled socket per request, so a pooled unguarded connection is never reused.
  https.request(url, { ...options, method: 'GET', agent: false, lookup: options.lookup as never }, (res) =>
    onResponse(res as unknown as FetchResponse),
  ) as unknown as FetchRequest;

export interface FetchOptions {
  lookup?: GuardedLookup;
  request?: RequestFn;
  maxBytes?: number;
  /** Overall budget across all hops. */
  timeoutMs?: number;
  /** Budget to connect and receive headers, per hop. */
  headersTimeoutMs?: number;
  maxRedirects?: number;
}

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function fileNameFrom(disposition: string | undefined, finalUrl: URL): string {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(disposition ?? '');
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '');
  let name = '';
  try {
    name = star?.[1] ? decodeURIComponent(star[1]) : (plain?.[1] ?? '');
  } catch {
    name = plain?.[1] ?? '';
  }
  if (!name) {
    const seg = finalUrl.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(seg);
    } catch {
      name = seg;
    }
    if (name && !/\.pdf$/i.test(name)) name = `${name}.pdf`;
  }
  name = name
    .replace(/[\\/\0]/g, '_')
    .trim()
    .slice(0, 200);
  return name || 'document.pdf';
}

/** `%PDF-` within the first KB, as the PDF spec allows. */
export const hasPdfMagic = (d: Uint8Array) => Buffer.from(d.subarray(0, 1024)).includes('%PDF-');

export async function fetchPublicPdf(
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<{ data: Uint8Array; fileName: string; finalUrl: string }> {
  const maxBytes = opts.maxBytes ?? envNum(process.env.MCP_UPLOAD_MAX_URL_BYTES, 50 * 1024 * 1024);
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const lookup = opts.lookup ?? makeGuardedLookup();
  const request = opts.request ?? defaultRequest;
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new FetchRefused('Fetching that URL took too long.');

  let url = assertFetchableUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const current = url;
    const sniHost = current.hostname.replace(/^\[|\]$/g, '');
    const outcome = await new Promise<
      { kind: 'redirect'; location: string } | { kind: 'body'; data: Uint8Array; res: FetchResponse }
    >((resolve, reject) => {
      let settled = false;
      let req: FetchRequest | undefined;
      let res: FetchResponse | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const fail = (err: Error) =>
        finish(() => {
          res?.destroy();
          req?.destroy();
          reject(err);
        });
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(timedOut()), Math.max(1, ms));
      };
      arm(Math.min(headersTimeoutMs, deadline - Date.now()));
      try {
        req = request(
          current,
          {
            lookup,
            servername: net.isIP(sniHost) ? undefined : sniHost,
            headers: {
              'accept-encoding': 'identity',
              'user-agent': 'QuireMCP/1',
              accept: 'application/pdf,*/*;q=0.5',
            },
          },
          (r) => {
            res = r;
            const status = r.statusCode ?? 0;
            const location = header(r.headers.location);
            if ([301, 302, 303, 307, 308].includes(status) && location) {
              return finish(() => {
                r.destroy();
                resolve({ kind: 'redirect', location });
              });
            }
            if (status !== 200)
              return fail(new FetchRefused(`The server answered HTTP ${status}, not a PDF download.`));
            const declared = Number(header(r.headers['content-length']));
            if (Number.isFinite(declared) && declared > maxBytes) {
              return fail(
                new FetchRefused(`That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`),
              );
            }
            arm(deadline - Date.now());
            const chunks: Uint8Array[] = [];
            let total = 0;
            r.on('data', (chunk) => {
              total += chunk.byteLength;
              if (total > maxBytes) {
                return fail(
                  new FetchRefused(
                    `That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`,
                  ),
                );
              }
              chunks.push(chunk);
            });
            r.on('end', () => finish(() => resolve({ kind: 'body', data: Buffer.concat(chunks), res: r })));
            r.on('close', () =>
              fail(new FetchRefused('The connection closed before the download finished.')),
            );
            r.on('error', () => fail(new FetchRefused('The download failed.')));
          },
        );
        req.on('error', (err) =>
          fail(
            err instanceof FetchRefused
              ? err
              : new FetchRefused('Could not fetch that URL (connection failed).'),
          ),
        );
        req.end();
      } catch (err) {
        fail(err instanceof FetchRefused ? err : new FetchRefused('Could not fetch that URL.'));
      }
    });

    if (outcome.kind === 'redirect') {
      if (hop >= maxRedirects) throw new FetchRefused('Too many redirects.');
      let next: string;
      try {
        next = new URL(outcome.location, current).toString();
      } catch {
        throw new FetchRefused('The server sent an invalid redirect.');
      }
      url = assertFetchableUrl(next);
      continue;
    }
    if (!hasPdfMagic(outcome.data)) {
      const type = header(outcome.res.headers['content-type']) ?? '';
      throw new FetchRefused(
        /html/i.test(type)
          ? 'That URL returned a web page, not a PDF. Pass the direct PDF link (e.g. https://arxiv.org/pdf/<id>).'
          : 'That URL did not return a PDF (not a PDF).',
      );
    }
    return {
      data: outcome.data,
      fileName: fileNameFrom(header(outcome.res.headers['content-disposition']), current),
      finalUrl: current.toString(),
    };
  }
}
