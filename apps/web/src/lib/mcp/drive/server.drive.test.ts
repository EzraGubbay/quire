// Registration of the Drive tools (config + write flag gating, description, annotations, schema) through the
// real MCP SDK over an in-memory transport.
import { generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/documents', () => ({
  createMarkdownDocument: vi.fn(),
  createPdfDocument: vi.fn(),
  listFolders: vi.fn(),
}));
vi.mock('@/lib/notes', () => ({ createNote: vi.fn() }));
vi.mock('@/lib/ai/index', () => ({ indexOwner: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../upload-store', () => ({
  findNoteByTitle: vi.fn(),
  findMarkdownDoc: vi.fn(),
  findDuplicatePdf: vi.fn(),
  setContentHash: vi.fn(),
}));
vi.mock('./store', () => ({ findDocsByHashes: vi.fn() }));
vi.mock('../courses', () => ({
  resolveCourse: vi.fn(),
  resolveFile: vi.fn(),
  readFileBytes: vi.fn(),
  listCourses: vi.fn(),
  listCourseFiles: vi.fn(),
  listAllFileResources: vi.fn(),
}));

const { registerQuireMcp } = await import('../server');
const { resetDriveConfig } = await import('./config');

const INBOX = '1PrV6lIDdZVi5xw_il9mxg3qfFr3pdteH';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const cred = Buffer.from(
  JSON.stringify({ type: 'service_account', client_email: 'a@b.c', private_key: pem }),
).toString('base64');

async function connect() {
  const server = new McpServer({ name: 'test', version: '0' });
  registerQuireMcp(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const names = async () => (await (await connect()).listTools()).tools.map((t) => t.name);

afterEach(() => {
  for (const k of ['DRIVE_SERVICE_ACCOUNT_JSON_BASE64', 'QUIRE_DRIVE_INBOX_FOLDER_ID', 'MCP_WRITE_ENABLED'])
    delete process.env[k];
  resetDriveConfig();
  vi.restoreAllMocks();
});

describe('Drive tool registration', () => {
  it('is absent when the Drive env is unset, and the T2 tools are unaffected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = await names();
    expect(n).not.toContain('import_from_drive');
    expect(n).not.toContain('drive_inbox_status');
    expect(n).toContain('upload_markdown');
  });

  it('is absent when writes are disabled', async () => {
    process.env.DRIVE_SERVICE_ACCOUNT_JSON_BASE64 = cred;
    process.env.QUIRE_DRIVE_INBOX_FOLDER_ID = INBOX;
    process.env.MCP_WRITE_ENABLED = 'false';
    const n = await names();
    expect(n).not.toContain('import_from_drive');
    expect(n).not.toContain('drive_inbox_status');
  });

  it('is present when configured, with the Inbox id, annotations, and no bytes field', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.DRIVE_SERVICE_ACCOUNT_JSON_BASE64 = cred;
    process.env.QUIRE_DRIVE_INBOX_FOLDER_ID = INBOX;
    const client = await connect();
    const by = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    const imp = by.get('import_from_drive');
    expect(imp?.description).toMatch(/^WRITES to Quire:/);
    expect(imp?.description).toContain(INBOX);
    expect(imp?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(by.get('drive_inbox_status')?.annotations).toMatchObject({ readOnlyHint: true });
    for (const t of [imp, by.get('drive_inbox_status')]) {
      expect(Object.keys((t?.inputSchema.properties ?? {}) as object).join()).not.toMatch(
        /base64|data|bytes|content/i,
      );
    }
  });

  it('returns an isError result with one text item when fileId is missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.DRIVE_SERVICE_ACCOUNT_JSON_BASE64 = cred;
    process.env.QUIRE_DRIVE_INBOX_FOLDER_ID = INBOX;
    const r = await (await connect()).callTool({
      name: 'import_from_drive',
      arguments: { course: 'c', section: 'documents' },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
  });
});
