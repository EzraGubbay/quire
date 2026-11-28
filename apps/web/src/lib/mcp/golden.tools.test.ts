// @vitest-environment node
// Golden transcripts for tools/list and resources/templates/list of both MCP servers. The tool descriptions
// are a prompt contract, so any change must show up as a reviewable diff. Needs no database, so it runs in
// every CI job. Regenerate with UPDATE_GOLDENS=1 (see golden.db.integration.test.ts for the seeded part).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  connectMcp,
  expectGolden,
  type GoldenDir,
  type NormCtx,
  normalize,
  pinEnv,
} from '@/lib/testing/mcp-golden';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'quire-mcp-golden-tools-'));
process.env.FILES_DIR = tmp;
pinEnv();

const { registerQuireMcp } = await import('./server');
const { registerQuireResearchMcp } = await import('@/lib/mcp-research/server');

const ctx: NormCtx = { ids: {}, slugs: {}, run: 'no-run-token', filesDir: tmp, step: 'tools' };
const dirs = {
  course: {
    dir: new URL('./__golden__/course/', import.meta.url),
    dumpDir: new URL('../../../test-results/mcp-golden/course/', import.meta.url),
  },
  research: {
    dir: new URL('./__golden__/research/', import.meta.url),
    dumpDir: new URL('../../../test-results/mcp-golden/research/', import.meta.url),
  },
} satisfies Record<string, GoldenDir>;

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const servers = [
  { name: 'course', register: registerQuireMcp, path: '/mcp', route: () => import('@/app/mcp/route') },
  {
    name: 'research',
    register: registerQuireResearchMcp,
    path: '/research/mcp',
    route: () => import('@/app/research/mcp/route'),
  },
] as const;

describe.each(servers)('$name MCP server goldens', (s) => {
  it('tools/list', async () => {
    const client = await connectMcp(s.register);
    const { tools } = await client.listTools();
    await expectGolden(dirs[s.name], 'tools-list', {
      request: { method: 'tools/list' },
      response: normalize(tools, ctx),
    });
  });

  it('resources/templates/list', async () => {
    const client = await connectMcp(s.register);
    const { resourceTemplates } = await client.listResourceTemplates();
    await expectGolden(dirs[s.name], 'resource-templates', {
      request: { method: 'resources/templates/list' },
      response: normalize(resourceTemplates, ctx),
    });
  });

  it('the deployed route serves the same tools as the in-memory harness', async () => {
    const client = await connectMcp(s.register);
    const { tools } = await client.listTools();
    const route = await s.route();
    const res = await route.POST(
      new Request(`http://localhost${s.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    const body = await res.text();
    const data = body.split('\n').find((l) => l.startsWith('data:'));
    const payload = JSON.parse(data ? data.slice(5) : body) as { result: { tools: unknown[] } };
    expect(payload.result.tools).toEqual(JSON.parse(JSON.stringify(tools)));
  });
});
