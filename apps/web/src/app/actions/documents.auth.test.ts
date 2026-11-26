// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ deleteDocument: vi.fn(), getProjectBySlug: vi.fn() }));

process.env.AUTH_MODE = 'github';
vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('@/lib/documents', () => ({ deleteDocument: h.deleteDocument }));
vi.mock('@/lib/projects', () => ({ getProjectBySlug: h.getProjectBySlug, projectBase: () => '/c/algo' }));
vi.mock('@/db', () => ({ db: {} }));

describe('deleteDocumentAction without a session', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects with UnauthorizedError and never touches the db', async () => {
    const { deleteDocumentAction } = await import('./documents');
    const { UnauthorizedError } = await import('@/lib/require-session');
    await expect(deleteDocumentAction('algo', 'd1')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(h.deleteDocument).not.toHaveBeenCalled();
    expect(h.getProjectBySlug).not.toHaveBeenCalled();
  });
});
