// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inner = vi.fn(async () => new Response('mcp-ok'));
vi.mock('mcp-handler', () => ({ createMcpHandler: () => inner }));
vi.mock('@/lib/mcp-research/server', () => ({ registerQuireResearchMcp: vi.fn() }));

const { POST, GET, DELETE } = await import('./route');
const call = (auth?: string) =>
  POST(
    new Request('http://x/research/mcp', {
      method: 'POST',
      headers: auth === undefined ? {} : { authorization: auth },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_MODE = 'github';
  process.env.QUIRE_API_KEY = 'master';
  process.env.QUIRE_RESEARCH_API_KEY = 'qk_r_research';
});
afterEach(() => {
  for (const k of ['AUTH_MODE', 'QUIRE_API_KEY', 'QUIRE_RESEARCH_API_KEY']) delete process.env[k];
});

describe('/research/mcp route guard', () => {
  it('exports GET, POST and DELETE', () => {
    expect([typeof GET, typeof POST, typeof DELETE]).toEqual(['function', 'function', 'function']);
  });
  it('github mode: no header -> 401', async () => {
    expect((await call()).status).toBe(401);
    expect(inner).not.toHaveBeenCalled();
  });
  it('github mode: the master key is rejected', async () => {
    expect((await call('Bearer master')).status).toBe(401);
    expect(inner).not.toHaveBeenCalled();
  });
  it('github mode: the research key reaches the handler', async () => {
    const res = await call('Bearer qk_r_research');
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });
  it('unset research key -> 401 even for an empty bearer', async () => {
    delete process.env.QUIRE_RESEARCH_API_KEY;
    expect((await call('Bearer ')).status).toBe(401);
    expect((await call('Bearer undefined')).status).toBe(401);
  });
  it('AUTH_MODE=none is open', async () => {
    process.env.AUTH_MODE = 'none';
    expect((await call()).status).toBe(200);
  });
});
