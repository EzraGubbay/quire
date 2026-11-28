// Test-only harness for the MCP golden transcripts: an in-memory SDK client, a normalizer that turns every
// seeded id, slug, run token and timestamp into a stable placeholder, and the golden compare/write helpers.
// Goldens are committed to a public repo, so the normalizer THROWS on any UUID it was not told about (a real
// entity from a dev database) and on any leaked FILES_DIR path.
// Must not import anything from `@/lib/*` that loads `files.ts`: callers set FILES_DIR before their dynamic
// imports, and this module is imported statically.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect } from 'vitest';

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** Connects an in-memory client to a server that registered the same capabilities as the routes. */
export async function connectMcp(register: (s: McpServer) => void): Promise<Client> {
  const server = new McpServer(
    { name: 'golden', version: '0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'golden', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** Removes every env var that changes tool descriptions or registration, so goldens are machine-independent. */
export function pinEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('MCP_')) delete process.env[k];
  delete process.env.QUIRE_PUBLIC_URL;
  delete process.env.DRIVE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOTENBERG_URL;
  process.env.AUTH_MODE = 'none';
}

export interface NormCtx {
  /** Seeded entity name to uuid. */
  ids: Record<string, string>;
  /** Seeded slug to placeholder name, e.g. { 'golden-course-ab12': 'course' }. */
  slugs: Record<string, string>;
  run: string;
  filesDir: string;
  /** Label for error messages. */
  step?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

export function normString(s: string, ctx: NormCtx): string {
  const step = ctx.step ?? '?';
  if (ctx.filesDir && s.includes(ctx.filesDir)) throw new Error(`FILES_DIR leaked in ${step}`);
  let out = s;
  for (const [name, id] of Object.entries(ctx.ids)) out = out.split(id).join(`<id:${name}>`);
  out = out.split(MISSING_ID).join('<id:missing>');
  const stray = out.match(UUID);
  if (stray) throw new Error(`unknown uuid in ${step}: ${stray[0]}`);
  for (const [slug, name] of Object.entries(ctx.slugs)) out = out.split(slug).join(`<slug:${name}>`);
  out = out.split(ctx.run).join('<run>');
  return out.replace(ISO, '<ts>');
}

export function normalize(value: unknown, ctx: NormCtx): unknown {
  if (typeof value === 'string') return normString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => normalize(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        normString(k, ctx),
        normalize(v, ctx),
      ]),
    );
  }
  return value;
}

function textItem(text: string, ctx: NormCtx): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (JSON.stringify(parsed, null, 2) === text) return { type: 'text', json: normalize(parsed, ctx) };
  } catch {
    // not JSON
  }
  if (text.includes('\n')) return { type: 'text', lines: normString(text, ctx).split('\n') };
  return { type: 'text', text: normString(text, ctx) };
}

function blob(b64: string): { bytes: number; sha256: string } {
  const buf = Buffer.from(b64, 'base64');
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/**
 * Images are shape-only: JPEG size depends on the canvas build and platform, and goldens are generated on
 * macOS and checked on Linux.
 */
function imageItem(it: { mimeType?: string; data: string }, imageMaxBytes: number): Record<string, unknown> {
  const buf = Buffer.from(it.data, 'base64');
  return {
    type: 'image',
    mimeType: it.mimeType,
    jpeg: buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    nonEmpty: buf.length > 0,
    withinCap: buf.length <= imageMaxBytes,
  };
}

function resourceBody(r: Record<string, unknown>, ctx: NormCtx): Record<string, unknown> {
  const out: Record<string, unknown> = { uri: normString(String(r.uri), ctx), mimeType: r.mimeType };
  if (typeof r.text === 'string') {
    const { type: _t, ...rest } = textItem(r.text, ctx);
    Object.assign(out, rest);
  }
  if (typeof r.blob === 'string') out.blob = blob(r.blob);
  return out;
}

/** Maps a tool result or a resources/read result to its reviewable, normalized golden form. */
export function goldenResult(
  res: { content?: unknown[]; contents?: unknown[]; isError?: boolean },
  ctx: NormCtx,
  imageMaxBytes: number,
): unknown {
  if (res.contents)
    return { contents: res.contents.map((c) => resourceBody(c as Record<string, unknown>, ctx)) };
  const content = (res.content ?? []).map((raw) => {
    const it = raw as Record<string, unknown> & { type: string };
    if (it.type === 'text') return textItem(String(it.text), ctx);
    if (it.type === 'image')
      return imageItem(it as unknown as { mimeType?: string; data: string }, imageMaxBytes);
    if (it.type === 'resource') {
      return { type: 'resource', resource: resourceBody(it.resource as Record<string, unknown>, ctx) };
    }
    return normalize(it, ctx);
  });
  return { ...(res.isError ? { isError: true } : {}), content };
}

const serialize = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;
const updating = () => process.env.UPDATE_GOLDENS === '1';

export interface GoldenDir {
  /** Directory the committed goldens live in. */
  dir: URL;
  /** Where actual output is dumped on a mismatch (CI uploads it as an artifact). */
  dumpDir: URL;
}

export async function expectGolden(g: GoldenDir, name: string, value: unknown): Promise<void> {
  const file = new URL(`${name}.json`, g.dir);
  const actual = serialize(value);
  if (updating()) {
    await mkdir(g.dir, { recursive: true });
    await writeFile(file, actual);
    return;
  }
  let committed: string | null = null;
  try {
    committed = await readFile(file, 'utf8');
  } catch {
    // missing
  }
  if (committed !== actual) {
    await mkdir(g.dumpDir, { recursive: true });
    await writeFile(new URL(`${name}.json`, g.dumpDir), actual);
  }
  expect(committed, `${name}: run UPDATE_GOLDENS=1 to regenerate if this change is intended`).toBe(actual);
}

/** The golden directory must hold exactly the expected files; under UPDATE_GOLDENS=1 extras are deleted. */
export async function assertNoStale(dir: URL, expected: string[]): Promise<void> {
  let present: string[] = [];
  try {
    present = (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    // no directory yet
  }
  const extras = present.filter((n) => !expected.includes(n));
  if (updating()) {
    for (const n of extras) await rm(new URL(`${n}.json`, dir));
    return;
  }
  expect(extras, 'stale golden files with no step').toEqual([]);
  expect(
    expected.filter((n) => !present.includes(n)),
    'missing golden files',
  ).toEqual([]);
}
