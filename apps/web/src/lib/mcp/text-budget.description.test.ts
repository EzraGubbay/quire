// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { pinEnv } from '@/lib/testing/mcp-golden';

const filesDir = mkdtempSync(join(tmpdir(), 'quire-mcp-budget-'));
process.env.FILES_DIR = filesDir;

afterAll(() => rmSync(filesDir, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.MCP_TEXT_BUDGET_CHARS;
});

/** Loads both servers fresh (the budget is read once at module load) and captures each get_file description. */
async function load(env?: string) {
  vi.resetModules();
  pinEnv();
  if (env !== undefined) process.env.MCP_TEXT_BUDGET_CHARS = env;
  const { TEXT_BUDGET } = await import('./content');
  const { registerQuireMcp } = await import('./server');
  const { registerQuireResearchMcp } = await import('@/lib/mcp-research/server');
  const capture = (register: (s: never) => void) => {
    const descriptions = new Map<string, string>();
    register({
      tool: (name: string, description: string) => descriptions.set(name, description),
      resource: () => {},
    } as never);
    return descriptions.get('get_file') ?? '';
  };
  return {
    budget: TEXT_BUDGET,
    course: capture(registerQuireMcp),
    research: capture(registerQuireResearchMcp),
  };
}

describe('get_file description states the real text budget', () => {
  it('defaults to 20,000 and never says 30k', async () => {
    const r = await load();
    expect(r.budget).toBe(20000);
    for (const d of [r.course, r.research]) {
      expect(d).toContain('up to 20,000 characters of page text per call');
      expect(d).not.toContain('30k');
    }
  });

  it('follows a valid MCP_TEXT_BUDGET_CHARS override', async () => {
    const r = await load('5000');
    expect(r.budget).toBe(5000);
    for (const d of [r.course, r.research]) expect(d).toContain('up to 5,000 characters');
  });

  it('ignores a value below 1000, like the enforced budget', async () => {
    const r = await load('500');
    expect(r.budget).toBe(20000);
    for (const d of [r.course, r.research]) expect(d).toContain('up to 20,000 characters');
  });
});
