// Source discovery: search arXiv and Semantic Scholar for a query, drop what the project already has,
// rank with the light model, and hand back candidates that can be added in one click.
import { eq } from 'drizzle-orm';
import { XMLParser } from 'fast-xml-parser';
import { db } from '@/db/client';
import { documents, sources } from '@/db/schema';
import { assertBudget, estimateTokens, recordUsage } from './ledger';
import { aiMock } from './mock';
import { chat } from './provider';
import { costFor, getAiSettings } from './settings';

export interface Candidate {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  url: string;
  arxivId?: string | null;
  doi?: string | null;
  pdfUrl?: string | null;
  citations?: number | null;
  origin: 'arxiv' | 'semanticscholar' | 'web';
  /** From the ranking model. */
  reason?: string;
  score?: number;
  alreadyInProject?: boolean;
}

const UA = 'Quire/0.1 (personal research manager; mailto:quire@ezragubbay.com)';

export async function searchArxiv(
  query: string,
  fetchImpl: typeof fetch = fetch,
  max = 15,
): Promise<Candidate[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${max}&sortBy=relevance`;
  const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`arXiv search ${res.status}`);
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(await res.text()) as {
    feed?: { entry?: unknown };
  };
  const raw = parsed.feed?.entry;
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
    id?: string;
    title?: string;
    summary?: string;
    published?: string;
    author?: { name: string } | { name: string }[];
    'arxiv:doi'?: { '#text': string };
  }[];
  return entries.flatMap((e) => {
    const id = e.id?.match(/abs\/([^v\s]+)(v\d+)?$/)?.[1];
    if (!id) return [];
    const authorsRaw = e.author;
    const authors = (Array.isArray(authorsRaw) ? authorsRaw : authorsRaw ? [authorsRaw] : []).map((a) =>
      a.name.trim(),
    );
    return [
      {
        id: `arxiv:${id}`,
        title: (e.title ?? '').replace(/\s+/g, ' ').trim(),
        authors,
        year: e.published ? Number(e.published.slice(0, 4)) : null,
        abstract: (e.summary ?? '').replace(/\s+/g, ' ').trim(),
        url: `https://arxiv.org/abs/${id}`,
        arxivId: id,
        doi: e['arxiv:doi']?.['#text'] ?? null,
        pdfUrl: `https://arxiv.org/pdf/${id}`,
        origin: 'arxiv' as const,
      },
    ];
  });
}

export async function searchSemanticScholar(
  query: string,
  fetchImpl: typeof fetch = fetch,
  max = 15,
): Promise<Candidate[]> {
  const fields = 'title,abstract,year,authors,externalIds,url,openAccessPdf,citationCount';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&fields=${fields}`;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) return [];
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      paperId: string;
      title?: string;
      abstract?: string | null;
      year?: number | null;
      authors?: { name: string }[];
      externalIds?: Record<string, string>;
      url?: string;
      openAccessPdf?: { url?: string } | null;
      citationCount?: number;
    }[];
  };
  return (data.data ?? []).map((p) => ({
    id: `s2:${p.paperId}`,
    title: p.title ?? '',
    authors: (p.authors ?? []).map((a) => a.name),
    year: p.year ?? null,
    abstract: p.abstract ?? '',
    url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    pdfUrl:
      p.openAccessPdf?.url ?? (p.externalIds?.ArXiv ? `https://arxiv.org/pdf/${p.externalIds.ArXiv}` : null),
    citations: p.citationCount ?? null,
    origin: 'semanticscholar' as const,
  }));
}

function norm(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Merges the two result sets: same arXiv id, DOI, or title collapses into one candidate (arXiv metadata wins, S2 adds citations). */
export function mergeCandidates(lists: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  const key = (c: Candidate) => c.arxivId?.toLowerCase() ?? c.doi?.toLowerCase() ?? norm(c.title);
  const seen = new Map<string, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      if (!c.title) continue;
      const k = key(c);
      const existing = seen.get(k) ?? [...seen.values()].find((x) => norm(x.title) === norm(c.title));
      if (existing) {
        if (existing.citations == null && c.citations != null) existing.citations = c.citations;
        if (!existing.doi && c.doi) existing.doi = c.doi;
        if (!existing.arxivId && c.arxivId) existing.arxivId = c.arxivId;
        if (!existing.pdfUrl && c.pdfUrl) existing.pdfUrl = c.pdfUrl;
        continue;
      }
      seen.set(k, c);
      out.push(c);
    }
  }
  return out;
}

async function markKnown(projectId: string, cands: Candidate[]): Promise<void> {
  const rows = await db
    .select({ arxivId: documents.arxivId, doi: documents.doi, title: documents.title })
    .from(documents)
    .where(eq(documents.projectId, projectId));
  const srcs = await db
    .select({ url: sources.url, title: sources.title })
    .from(sources)
    .where(eq(sources.projectId, projectId));
  const knownArxiv = new Set(rows.map((r) => r.arxivId?.toLowerCase()).filter(Boolean));
  const knownDoi = new Set(rows.map((r) => r.doi?.toLowerCase()).filter(Boolean));
  const knownTitle = new Set([...rows.map((r) => norm(r.title)), ...srcs.map((s) => norm(s.title))]);
  const knownUrl = new Set(srcs.map((s) => s.url ?? ''));
  for (const c of cands) {
    c.alreadyInProject = Boolean(
      (c.arxivId && knownArxiv.has(c.arxivId.toLowerCase())) ||
        (c.doi && knownDoi.has(c.doi.toLowerCase())) ||
        knownTitle.has(norm(c.title)) ||
        knownUrl.has(c.url),
    );
  }
}

const MOCK: Candidate[] = [
  {
    id: 'arxiv:1706.03762',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: 2017,
    abstract:
      'The dominant sequence transduction models are based on complex recurrent or convolutional networks.',
    url: 'https://arxiv.org/abs/1706.03762',
    arxivId: '1706.03762',
    pdfUrl: 'https://arxiv.org/pdf/1706.03762',
    citations: 120000,
    origin: 'arxiv',
  },
  {
    id: 's2:mock2',
    title: 'Mixture-of-Depths: Dynamically allocating compute in transformer-based language models',
    authors: ['David Raposo'],
    year: 2024,
    abstract: 'Transformer-based language models spread FLOPs uniformly across input sequences.',
    url: 'https://arxiv.org/abs/2404.02258',
    arxivId: '2404.02258',
    pdfUrl: 'https://arxiv.org/pdf/2404.02258',
    citations: 300,
    origin: 'semanticscholar',
  },
  {
    id: 's2:mock3',
    title: 'Routing Transformer',
    authors: ['Aurko Roy'],
    year: 2020,
    abstract: 'Sparse attention via content-based routing.',
    url: 'https://www.semanticscholar.org/paper/mock3',
    doi: '10.1162/tacl_a_00353',
    citations: 900,
    origin: 'semanticscholar',
  },
];

export interface DiscoverResult {
  query: string;
  candidates: Candidate[];
  ranked: boolean;
  note?: string;
}

export async function discover(
  projectId: string,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverResult> {
  const q = query.trim();
  if (!q) return { query: q, candidates: [], ranked: false };
  let merged: Candidate[];
  const notes: string[] = [];
  if (aiMock()) merged = MOCK.map((c) => ({ ...c }));
  else {
    const [ax, s2] = await Promise.allSettled([
      searchArxiv(q, fetchImpl),
      searchSemanticScholar(q, fetchImpl),
    ]);
    if (ax.status === 'rejected') notes.push(`arXiv: ${(ax.reason as Error).message}`);
    if (s2.status === 'rejected') notes.push(`Semantic Scholar: ${(s2.reason as Error).message}`);
    merged = mergeCandidates([
      ax.status === 'fulfilled' ? ax.value : [],
      s2.status === 'fulfilled' ? s2.value : [],
    ]);
  }
  await markKnown(projectId, merged);
  const ranked = await rank(projectId, q, merged, notes);
  const out: DiscoverResult = { query: q, candidates: ranked.list, ranked: ranked.ok };
  if (notes.length) out.note = notes.join(' · ');
  return out;
}

/** Asks the light model for an ordering with one-line reasons; falls back to citations and recency. */
async function rank(
  projectId: string,
  query: string,
  cands: Candidate[],
  notes: string[],
): Promise<{ list: Candidate[]; ok: boolean }> {
  const fallback = () => ({
    list: [...cands].sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0) || (b.year ?? 0) - (a.year ?? 0)),
    ok: false,
  });
  if (cands.length === 0) return { list: [], ok: false };
  const s = await getAiSettings();
  const model = s.models.light;
  const listing = cands
    .map(
      (c, i) =>
        `${i + 1}. ${c.title} (${c.year ?? 'n.d.'}; ${c.authors.slice(0, 3).join(', ')}; ${c.citations ?? '?'} citations)\n   ${c.abstract.slice(0, 400)}`,
    )
    .join('\n');
  const prompt = `A researcher is looking for: "${query}".\n\nCandidates:\n${listing}\n\nReturn JSON only: {"ranking":[{"n":<candidate number>,"score":<0-10>,"reason":"<one short sentence why it is or is not relevant>"}]} covering every candidate, most relevant first.`;
  const est = costFor(s.prices, model, { input: estimateTokens(prompt), cached: 0, output: 800 });
  try {
    await assertBudget(est, s);
    const res = await chat([{ role: 'user', content: prompt }], { model, settings: s, maxTokens: 1500 });
    await recordUsage({ projectId, task: 'discover-rank', model: res.model, usage: res.usage, settings: s });
    const json = res.text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json
      ? (JSON.parse(json) as { ranking?: { n: number; score?: number; reason?: string }[] })
      : null;
    if (!parsed?.ranking?.length) throw new Error('no ranking');
    const byN = new Map(parsed.ranking.map((r) => [r.n, r]));
    const list = cands
      .map((c, i) => ({ ...c, score: byN.get(i + 1)?.score ?? 0, reason: byN.get(i + 1)?.reason ?? '' }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { list, ok: true };
  } catch (err) {
    if (aiMock())
      return {
        list: cands.map((c, i) => ({
          ...c,
          score: 9 - i,
          reason: 'Mock reason: closely related to the query.',
        })),
        ok: true,
      };
    notes.push(`ranking skipped: ${(err as Error).message}`);
    return fallback();
  }
}
