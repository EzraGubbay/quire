// @vitest-environment node
// Characterization (S0.4, quire#105): the note and source Markdown exports, frozen before S1.2 moves them onto the
// shared name and markdown helpers. A diff here must be intentional and listed in that PR.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const project = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', kind: 'course' };
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async (s: string) => (s === 'algo' ? project : undefined)),
}));
const getNote = vi.fn();
const getNoteBySlug = vi.fn();
vi.mock('@/lib/notes', () => ({ getNote, getNoteBySlug }));
const getSource = vi.fn();
vi.mock('@/lib/sources', () => ({ getSource }));

const noteRoute = await import('@/app/api/projects/[slug]/notes/[noteId]/file/route');
const sourceRoute = await import('@/app/api/projects/[slug]/sources/[sourceId]/file/route');

const headersOf = (res: Response) => Object.fromEntries(res.headers);
const callNote = (noteId: string, slug = 'algo') =>
  noteRoute.GET(new Request('http://x/n'), { params: Promise.resolve({ slug, noteId }) });
const callSource = (sourceId: string, slug = 'algo') =>
  sourceRoute.GET(new Request('http://x/s'), { params: Promise.resolve({ slug, sourceId }) });

const MD_HEADERS = (name: string) => ({
  'content-type': 'text/markdown; charset=utf-8',
  'content-disposition': `attachment; filename*=UTF-8''${name}`,
  'cache-control': 'private, no-store',
});
const NOT_FOUND = { 'content-type': 'text/plain;charset=UTF-8' };

beforeEach(() => {
  getNote.mockReset();
  getNoteBySlug.mockReset();
  getSource.mockReset();
});

describe('note markdown export', () => {
  it('by id: heading plus the body as written, no trailing newline added', async () => {
    getNote.mockResolvedValue({ title: 'Lemma: A/B', body: 'x [[y]]' });
    const res = await callNote('n1');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(MD_HEADERS('Lemma%20%20A%20B.md'));
    expect(await res.text()).toBe('# Lemma: A/B\n\nx [[y]]');
    expect(getNote).toHaveBeenCalledWith(project.id, 'n1');
    expect(getNoteBySlug).not.toHaveBeenCalled();
  });

  it('falls back to lookup by note slug, id first', async () => {
    getNote.mockResolvedValue(undefined);
    getNoteBySlug.mockResolvedValue({ title: 'T', body: 'b' });
    const res = await callNote('t-slug');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# T\n\nb');
    expect(getNote).toHaveBeenCalledWith(project.id, 't-slug');
    expect(getNoteBySlug).toHaveBeenCalledWith(project.id, 't-slug');
    expect(getNote.mock.invocationCallOrder[0]).toBeLessThan(getNoteBySlug.mock.invocationCallOrder[0] ?? 0);
  });

  it('an all-forbidden title falls back to note.md', async () => {
    getNote.mockResolvedValue({ title: '???', body: 'b' });
    expect((await callNote('n1')).headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''note.md",
    );
  });

  it('404 for an unknown slug or an unknown note', async () => {
    for (const res of [await callNote('n1', 'nope'), await callNote('zzz')]) {
      expect(res.status).toBe(404);
      expect(headersOf(res)).toEqual(NOT_FOUND);
      expect(await res.text()).toBe('Not found');
    }
  });
});

describe('source markdown export', () => {
  it('a full source renders type, link, tags, description and captured text', async () => {
    getSource.mockResolvedValue({
      title: 'Paper: X',
      type: 'paper',
      url: 'https://example.org/x',
      tags: ['ml', 'rl'],
      description: 'Desc',
      snapshotText: 'Snap',
    });
    const res = await callSource('s1');
    expect(res.status).toBe(200);
    expect(headersOf(res)).toEqual(MD_HEADERS('Paper%20%20X.md'));
    expect(await res.text()).toBe(
      '# Paper: X\n\n- Type: paper\n- Link: https://example.org/x\n- Tags: #ml #rl\n\nDesc\n\n---\n\n## Captured text\n\nSnap\n',
    );
    expect(getSource).toHaveBeenCalledWith(project.id, 's1');
  });

  it('a minimal source is the heading and type only', async () => {
    getSource.mockResolvedValue({
      title: 'T',
      type: 'web',
      url: null,
      tags: [],
      description: null,
      snapshotText: null,
    });
    const res = await callSource('s1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# T\n\n- Type: web\n');
  });

  it('an all-forbidden title falls back to source.md', async () => {
    getSource.mockResolvedValue({
      title: '???',
      type: 'web',
      url: null,
      tags: [],
      description: null,
      snapshotText: null,
    });
    expect((await callSource('s1')).headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''source.md",
    );
  });

  it('404 for an unknown source or slug', async () => {
    getSource.mockResolvedValue(undefined);
    for (const res of [await callSource('zzz'), await callSource('s1', 'nope')]) {
      expect(res.status).toBe(404);
      expect(headersOf(res)).toEqual(NOT_FOUND);
      expect(await res.text()).toBe('Not found');
    }
  });
});
