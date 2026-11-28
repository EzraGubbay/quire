// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getSession: vi.fn(), createDeckDocument: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}) }));
vi.mock('@/lib/documents', () => ({ createDeckDocument: h.createDeckDocument }));
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async () => ({ id: 'p1', slug: 'algo' })),
  projectBase: () => '/c/algo',
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sessions')>()),
  getSession: h.getSession,
}));

const { POST } = await import('./route');

const post = (name: string) => {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' }));
  return POST(new Request('http://x/deck', { method: 'POST', body: fd }), {
    params: Promise.resolve({ slug: 'algo', sessionId: 's5' }),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue({ id: 's5', kind: 'lecture', number: 5, title: '' });
  h.createDeckDocument.mockResolvedValue({ id: 'd1', filePath: null });
});

describe('POST /api/projects/:slug/sessions/:id/deck', () => {
  it('returns a warning when the file name names another session', async () => {
    const res = await post('Lecture 3.pdf');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('d1');
    expect(body.warning).toMatch(/looks like Lecture 3.*attached to Lecture 5/);
  });

  it('returns only the id when the name matches', async () => {
    const res = await post('Lecture 5.pdf');
    expect(await res.json()).toEqual({ id: 'd1' });
  });
});
