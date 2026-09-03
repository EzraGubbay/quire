// Turning a pasted reference (arXiv id/URL, DOI, direct PDF URL) into metadata and PDF bytes.
import { XMLParser } from 'fast-xml-parser';

export type Reference =
  | { kind: 'arxiv'; id: string }
  | { kind: 'doi'; doi: string }
  | { kind: 'url'; url: string };

export interface PaperMeta {
  title?: string;
  authors?: string[];
  year?: number | null;
  abstract?: string;
  arxivId?: string | null;
  doi?: string | null;
  sourceUrl?: string | null;
  /** Where a PDF can be fetched, if known. */
  pdfUrl?: string | null;
}

const ARXIV_ID = /(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;

/** Classifies what the user pasted. Order matters: arXiv URLs contain ids, DOI URLs contain DOIs. */
export function parseReference(raw: string): Reference | null {
  const input = raw.trim();
  if (!input) return null;
  const arxivUrl = input.match(/arxiv\.org\/(?:abs|pdf|html)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i);
  if (arxivUrl?.[1]) return { kind: 'arxiv', id: arxivUrl[1].replace(/v\d+$/, '') };
  const arxivPrefixed = input.match(/^arxiv:\s*(.+)$/i);
  if (arxivPrefixed?.[1]) return { kind: 'arxiv', id: arxivPrefixed[1].trim().replace(/v\d+$/, '') };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(input)) return { kind: 'arxiv', id: input.replace(/v\d+$/, '') };
  const doiUrl = input.match(/doi\.org\/(10\.[^\s]+)/i);
  if (doiUrl?.[1]) return { kind: 'doi', doi: decodeURIComponent(doiUrl[1]) };
  const doiPrefixed = input.match(/^doi:\s*(10\..+)$/i);
  if (doiPrefixed?.[1]) return { kind: 'doi', doi: doiPrefixed[1].trim() };
  if (/^10\.\d{4,9}\//.test(input)) return { kind: 'doi', doi: input };
  if (/^https?:\/\//i.test(input)) return { kind: 'url', url: input };
  const bare = input.match(ARXIV_ID);
  if (bare?.[1] && /^[a-z-]+\//i.test(bare[1])) return { kind: 'arxiv', id: bare[1].replace(/v\d+$/, '') };
  const doiBare = input.match(DOI);
  if (doiBare?.[1]) return { kind: 'doi', doi: doiBare[1] };
  return null;
}

const UA = 'Quire/0.1 (personal research manager; mailto:quire@ezragubbay.com)';

export async function fetchArxivMeta(id: string, fetchImpl: typeof fetch = fetch): Promise<PaperMeta> {
  const res = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`arXiv API responded ${res.status}`);
  const xml = await res.text();
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    feed?: { entry?: ArxivEntry | ArxivEntry[] };
  };
  const entryRaw = parsed.feed?.entry;
  const entry = Array.isArray(entryRaw) ? entryRaw[0] : entryRaw;
  if (!entry || !entry.id) throw new Error(`arXiv has no record for ${id}`);
  const authorsRaw = entry.author;
  const authors = (Array.isArray(authorsRaw) ? authorsRaw : authorsRaw ? [authorsRaw] : []).map((a) =>
    a.name.trim(),
  );
  const published = entry.published ?? '';
  const doiLink = Array.isArray(entry.link)
    ? entry.link.find((l) => l['@_title'] === 'doi')?.['@_href']
    : undefined;
  return {
    title: entry.title?.replace(/\s+/g, ' ').trim(),
    authors,
    year: published ? Number(published.slice(0, 4)) : null,
    abstract: entry.summary?.replace(/\s+/g, ' ').trim() ?? '',
    arxivId: id,
    doi:
      entry['arxiv:doi']?.['#text'] ??
      (doiLink ? doiLink.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : null),
    sourceUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
  };
}

interface ArxivEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: { name: string } | { name: string }[];
  link?: { '@_href': string; '@_title'?: string }[];
  'arxiv:doi'?: { '#text': string };
}

export async function fetchDoiMeta(doi: string, fetchImpl: typeof fetch = fetch): Promise<PaperMeta> {
  const res = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error(`Crossref has no record for ${doi}`);
  if (!res.ok) throw new Error(`Crossref responded ${res.status}`);
  const { message: m } = (await res.json()) as { message: CrossrefWork };
  const year = m.issued?.['date-parts']?.[0]?.[0] ?? m.created?.['date-parts']?.[0]?.[0] ?? null;
  const authors = (m.author ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  const pdfLink = (m.link ?? []).find((l) => l['content-type'] === 'application/pdf')?.URL ?? null;
  const arxivMatch = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
  return {
    title: m.title?.[0]?.replace(/\s+/g, ' ').trim(),
    authors,
    year,
    abstract: stripJats(m.abstract ?? ''),
    doi,
    arxivId: arxivMatch?.[1] ?? null,
    sourceUrl: m.URL ?? `https://doi.org/${doi}`,
    pdfUrl: arxivMatch?.[1] ? `https://arxiv.org/pdf/${arxivMatch[1]}` : pdfLink,
  };
}

interface CrossrefWork {
  title?: string[];
  author?: { given?: string; family?: string }[];
  issued?: { 'date-parts'?: number[][] };
  created?: { 'date-parts'?: number[][] };
  abstract?: string;
  URL?: string;
  link?: { URL: string; 'content-type'?: string }[];
}

function stripJats(s: string): string {
  return s
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_PDF = 80 * 1024 * 1024;

/** Downloads a PDF, following redirects, rejecting non-PDF responses and anything over 80 MB. */
export async function downloadPdf(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; fileName: string }> {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'application/pdf,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_PDF) throw new Error('PDF is larger than 80 MB');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_PDF) throw new Error('PDF is larger than 80 MB');
  const head = new TextDecoder().decode(buf.slice(0, 5));
  if (!head.startsWith('%PDF')) {
    const type = res.headers.get('content-type') ?? 'unknown';
    throw new Error(
      `That link did not return a PDF (${type}). Paste a direct PDF link, an arXiv id, or a DOI.`,
    );
  }
  const fromDisposition = res.headers
    .get('content-disposition')
    ?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  const fromPath = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() ?? '');
  const fileName = (
    fromDisposition ?? (fromPath.endsWith('.pdf') ? fromPath : `${fromPath || 'document'}.pdf`)
  ).trim();
  return { data: buf, fileName };
}

/** Resolves a pasted reference to metadata plus a PDF URL where one is known. */
export async function resolveReference(ref: Reference, fetchImpl: typeof fetch = fetch): Promise<PaperMeta> {
  if (ref.kind === 'arxiv') return fetchArxivMeta(ref.id, fetchImpl);
  if (ref.kind === 'doi') return fetchDoiMeta(ref.doi, fetchImpl);
  return { sourceUrl: ref.url, pdfUrl: ref.url };
}
