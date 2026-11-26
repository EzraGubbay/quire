import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: async () => null }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ authorization: 'Bearer qk_r_research' }),
}));

describe('requireSession never accepts the research key', () => {
  beforeEach(() => {
    process.env.AUTH_MODE = 'github';
    process.env.ALLOWED_GITHUB_LOGIN = 'Ezra';
    process.env.QUIRE_API_KEY = 'master';
    process.env.QUIRE_RESEARCH_API_KEY = 'qk_r_research';
  });
  afterEach(() => {
    for (const k of ['AUTH_MODE', 'QUIRE_API_KEY', 'QUIRE_RESEARCH_API_KEY']) delete process.env[k];
  });
  it('throws Unauthorized for a Server Action carrying the research key', async () => {
    const { requireSession } = await import('./require-session');
    await expect(requireSession()).rejects.toThrow('Unauthorized');
  });
});
