// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  attachDocumentToSession: vi.fn(),
  getDocument: vi.fn(),
  createDeckDocument: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

vi.mock('@/lib/require-session', () => ({ requireSession: vi.fn(async () => ({})) }));
vi.mock('@/lib/projects', () => ({
  getProjectBySlug: vi.fn(async () => ({ id: 'p1', slug: 'algo' })),
  projectBase: () => '/c/algo',
}));
vi.mock('@/lib/documents', () => ({
  builtinFolder: vi.fn(),
  createDeckDocument: h.createDeckDocument,
  deleteDocument: vi.fn(),
  getDocument: h.getDocument,
}));
vi.mock('@/lib/notes', () => ({
  clearSessionNote: vi.fn(),
  createNote: vi.fn(),
  getNote: vi.fn(),
  listNotes: vi.fn(),
  sessionNote: vi.fn(),
  updateNote: vi.fn(),
}));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn(async () => {}), removeOwner: vi.fn(async () => {}) }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: h.redirect, notFound: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sessions')>()),
  createSession: h.createSession,
  getSession: h.getSession,
  attachDocumentToSession: h.attachDocumentToSession,
}));

const { dropSessionFilesAction, moveDeckToSessionAction } = await import('./sessions');

const lecture = (number: number) => ({ id: `s${number}`, kind: 'lecture', number, title: '' });
const drop = (name: string, extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set('slug', 'algo');
  fd.set('kind', 'lecture');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.append('files', new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' }));
  return dropSessionFilesAction({}, fd);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createDeckDocument.mockResolvedValue({ id: 'd1', filePath: null });
  h.createSession.mockImplementation(
    async (_p: string, i: { kind: string; number?: number; title: string }) => ({
      id: 'new1',
      kind: i.kind,
      number: i.number ?? 1,
      title: i.title,
    }),
  );
});

describe('moveDeckToSessionAction warnings', () => {
  it('warns but still attaches when the file name names another session', async () => {
    h.getDocument.mockResolvedValue({
      id: 'd1',
      sessionId: null,
      originalName: 'Lecture 3.pptx',
      title: 'x',
    });
    h.getSession.mockResolvedValue(lecture(5));
    const res = await moveDeckToSessionAction('algo', 'd1', 's5');
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/looks like Lecture 3/);
    expect(h.attachDocumentToSession).toHaveBeenCalledWith('p1', 'd1', 's5');
  });

  it('has no warning key when the name matches', async () => {
    h.getDocument.mockResolvedValue({
      id: 'd1',
      sessionId: null,
      originalName: 'Lecture 5.pptx',
      title: 'x',
    });
    h.getSession.mockResolvedValue(lecture(5));
    expect(await moveDeckToSessionAction('algo', 'd1', 's5')).toEqual({ ok: true });
  });

  it('never warns when unassigning', async () => {
    h.getDocument.mockResolvedValue({
      id: 'd1',
      sessionId: 's5',
      originalName: 'Lecture 3.pptx',
      title: 'x',
    });
    h.getSession.mockResolvedValue(lecture(5));
    expect(await moveDeckToSessionAction('algo', 'd1', null)).toEqual({ ok: true });
  });

  it('falls back to the title for a PDF with no stored file name', async () => {
    h.getDocument.mockResolvedValue({
      id: 'd1',
      sessionId: 's1',
      originalName: null,
      title: 'Lecture 1 — sample',
    });
    h.getSession.mockResolvedValue(lecture(2));
    const res = await moveDeckToSessionAction('algo', 'd1', 's2');
    expect(res.warning).toMatch(/looks like Lecture 1/);
  });
});

describe('dropSessionFilesAction warnings', () => {
  it('attaches to an explicit session and warns on a mismatched name', async () => {
    h.getSession.mockResolvedValue(lecture(5));
    const res = await drop('Lecture 3.pdf', { sessionId: 's5' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/looks like Lecture 3.*attached to Lecture 5/);
    expect(h.createDeckDocument).toHaveBeenCalledOnce();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('does not redirect a single flagged drop, and returns the warning', async () => {
    const res = await drop('Recitation 3.pdf');
    expect(res.created).toBe(1);
    expect(res.warning).toMatch(/Recitation 3/);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('still redirects a single clean drop', async () => {
    await expect(drop('sample.pdf')).rejects.toThrow('REDIRECT:/c/algo/lectures/new1');
  });
});
