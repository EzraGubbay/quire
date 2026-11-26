// Registration of the write tools (flag, descriptions, annotations) and their error semantics end to end
// through the real MCP SDK over an in-memory transport.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/documents', () => ({ createMarkdownDocument: vi.fn(), listFolders: vi.fn() }));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('./upload-store', () => ({
  findNoteByTitle: vi.fn(),
  findMarkdownDoc: vi.fn(),
}));
vi.mock('./courses', () => ({
  resolveCourse: vi.fn(async () => ({ id: 'p1', slug: 'c1', name: 'C1', kind: 'course' })),
  resolveFile: vi.fn(),
  readFileBytes: vi.fn(),
  listCourses: vi.fn(),
  listCourseFiles: vi.fn(),
  listAllFileResources: vi.fn(),
}));

const { registerQuireMcp } = await import('./server');

async function connect() {
  const server = new McpServer({ name: 'test', version: '0' });
  registerQuireMcp(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

afterEach(() => {
  delete process.env.MCP_WRITE_ENABLED;
});

describe('write tool registration', () => {
  it('lists the write tool by default, with WRITES descriptions and non-destructive annotations', async () => {
    const { tools } = await (await connect()).listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['upload_markdown']) {
      const t = byName.get(name);
      expect(t?.description).toMatch(/^WRITES to Quire:/);
      expect(t?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ['list_courses', 'list_course_files', 'get_file', 'get_page_images']) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it.each(['false', '0', 'off', 'No'])('hides the write tools when MCP_WRITE_ENABLED=%s', async (v) => {
    process.env.MCP_WRITE_ENABLED = v;
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('upload_markdown');
    expect(names).toEqual(
      expect.arrayContaining(['list_courses', 'list_course_files', 'get_file', 'get_page_images']),
    );
  });
});

describe('error semantics through the SDK', () => {
  it('errors when the write flag is off', async () => {
    process.env.MCP_WRITE_ENABLED = 'false';
    const res = await (await connect()).callTool({
      name: 'upload_markdown',
      arguments: { course: 'c1', markdown: '# T\nb' },
    });
    expect(res.isError).toBe(true);
  });

  it('returns a missing required argument as an isError text result', async () => {
    const res = await (await connect()).callTool({ name: 'upload_markdown', arguments: { course: 'c1' } });
    expect(res.isError).toBe(true);
    expect((res.content as { type: string }[])[0]?.type).toBe('text');
  });

  it('returns a tool-level failure (no title) as an isError text result', async () => {
    const res = await (await connect()).callTool({
      name: 'upload_markdown',
      arguments: { course: 'c1', markdown: 'no heading here' },
    });
    expect(res.isError).toBe(true);
    const content = res.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toMatch(/No title/);
  });
});

describe('no tool accepts file bytes', () => {
  it('has no base64, data or bytes input on any tool', async () => {
    const { tools } = await (await connect()).listTools();
    const banned = /base64|bytes|^data$|^file$|^blob$/i;
    for (const t of tools) {
      for (const field of Object.keys(t.inputSchema.properties ?? {})) {
        expect(field, `${t.name}.${field}`).not.toMatch(banned);
      }
    }
  });
});
