import type { SourceType } from '@quire/shared';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Source, sources } from '@/db/schema';

export async function listSources(projectId: string): Promise<Source[]> {
  return db.select().from(sources).where(eq(sources.projectId, projectId)).orderBy(desc(sources.updatedAt));
}

export async function getSource(projectId: string, id: string): Promise<Source | undefined> {
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.projectId, projectId)))
    .limit(1);
  return rows[0];
}

export interface SourceInput {
  type: SourceType;
  url: string | null;
  title: string;
  description: string;
  tags: string[];
  snapshotText?: string | null;
}

export async function createSource(projectId: string, input: SourceInput): Promise<Source> {
  const [row] = await db
    .insert(sources)
    .values({ projectId, ...input, snapshotAt: input.snapshotText ? new Date() : null })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

export async function updateSource(
  projectId: string,
  id: string,
  patch: Partial<SourceInput>,
): Promise<void> {
  await db
    .update(sources)
    .set({
      ...patch,
      updatedAt: new Date(),
      ...(patch.snapshotText !== undefined ? { snapshotAt: new Date() } : {}),
    })
    .where(and(eq(sources.id, id), eq(sources.projectId, projectId)));
}

export async function deleteSource(projectId: string, id: string): Promise<void> {
  await db.delete(sources).where(and(eq(sources.id, id), eq(sources.projectId, projectId)));
}

const UA = 'Quire/0.1 (personal research manager; mailto:quire@ezragubbay.com)';
const MAX_HTML = 5 * 1024 * 1024;

/** Fetches a page and returns its title plus readable text (tags stripped, scripts/styles dropped). */
export async function snapshotUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ title: string; text: string; type: SourceType }> {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const ct = res.headers.get('content-type') ?? '';
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_HTML) throw new Error('Page is larger than 5 MB');
  const body = new TextDecoder().decode(buf);
  const host = new URL(res.url || url).hostname.replace(/^www\./, '');
  const type = guessType(host, ct);
  if (!/html/i.test(ct)) return { title: host, text: '', type };
  const title = decodeEntities(body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim() || host;
  return { title, text: htmlToText(body).slice(0, 200_000), type };
}

export function guessType(host: string, contentType = ''): SourceType {
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(host)) return 'video';
  if (/github\.com|gitlab\.com|huggingface\.co/.test(host)) return 'repo';
  if (/kaggle\.com|zenodo\.org|data\./.test(host)) return 'dataset';
  if (/medium\.com|substack\.com|blog\./.test(host)) return 'post';
  if (/pdf/.test(contentType)) return 'other';
  return 'web';
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}
