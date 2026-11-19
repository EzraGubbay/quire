// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  API_VERSION,
  ChatStreamEvent,
  ERROR_CODES,
  ErrorEnvelope,
  Me,
  PairRequest,
  responseSchemas,
} from './schema';

const SPEC_PATH = fileURLToPath(new URL('../../../../../docs/api/mobile-v1.openapi.yaml', import.meta.url));
const raw = readFileSync(SPEC_PATH, 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: walking an arbitrary OpenAPI document
const spec = parse(raw) as any;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const EXPECTED_OPERATIONS = [
  'POST /auth/pair',
  'GET /me',
  'DELETE /auth/token',
  'GET /courses',
  'GET /courses/{course}',
  'GET /courses/{course}/sessions',
  'GET /courses/{course}/files',
  'GET /courses/{course}/files/{fileId}',
  'GET /courses/{course}/files/{fileId}/content',
  'GET /courses/{course}/notes',
  'GET /courses/{course}/notes/{noteId}',
  'GET /threads',
  'GET /courses/{course}/threads',
  'POST /courses/{course}/threads',
  'DELETE /courses/{course}/threads/{threadId}',
  'GET /courses/{course}/threads/{threadId}/messages',
  'POST /courses/{course}/threads/{threadId}/messages',
  'POST /courses/{course}/uploads',
  'GET /uploads/{uploadId}',
];

interface Resp {
  key: string;
  status: string;
  content: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, { value: unknown }> }>;
}

function responses(): Resp[] {
  const out: Resp[] = [];
  for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
    for (const m of METHODS) {
      // biome-ignore lint/suspicious/noExplicitAny: OpenAPI operation node
      const op = item[m] as any;
      if (!op) continue;
      for (const [status, r] of Object.entries<{ content?: Resp['content'] }>(op.responses)) {
        out.push({ key: `${m.toUpperCase()} ${path}`, status, content: r.content ?? {} });
      }
    }
  }
  return out;
}

const examplesOf = (c: Resp['content'][string]): unknown[] => [
  ...(c.example !== undefined ? [c.example] : []),
  ...Object.values(c.examples ?? {}).map((e) => e.value),
];

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1 with a bearer security scheme', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(spec.servers[0].url).toBe('/api/mobile/v1');
  });

  it('states the versioning policy at the top and ships a 1.x apiVersion', () => {
    const desc: string = spec.info.description;
    expect(desc).toMatch(/additive/i);
    expect(desc).toMatch(/\/v2/);
    expect(desc).toMatch(/apiVersion/);
    expect(spec.info.version).toBe(API_VERSION);
    expect(API_VERSION).toMatch(/^1\./);
  });

  it('defines every v1 operation from the epic', () => {
    const have = Object.entries<Record<string, unknown>>(spec.paths).flatMap(([p, item]) =>
      METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${p}`),
    );
    expect(have.sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it('requires bearer auth everywhere except pairing', () => {
    for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
      for (const m of METHODS.filter((x) => item[x])) {
        // biome-ignore lint/suspicious/noExplicitAny: OpenAPI operation node
        const op = item[m] as any;
        const key = `${m.toUpperCase()} ${path}`;
        if (key === 'POST /auth/pair') expect(op.security).toEqual([]);
        else expect(op.security ?? spec.security, key).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  it('error codes in the spec match the zod enum', () => {
    expect(spec.components.schemas.ErrorCode.enum).toEqual([...ERROR_CODES]);
    expect([...ERROR_CODES]).toEqual([
      'unauthorized',
      'not_found',
      'invalid_request',
      'rate_limited',
      'ai_unavailable',
      'internal',
    ]);
  });
});

describe('response examples vs zod (drift guard)', () => {
  const all = responses();

  it('every response has at least one example', () => {
    for (const r of all) {
      const media = Object.entries(r.content);
      if (media.length === 0) continue; // 204 / 304 style, no body
      for (const [type, c] of media) {
        if (type === 'application/pdf' || type === 'application/octet-stream') continue; // binary
        expect(examplesOf(c).length, `${r.key} ${r.status} ${type}`).toBeGreaterThan(0);
      }
    }
  });

  it('every JSON example parses with the matching zod schema', () => {
    let checked = 0;
    for (const r of all) {
      const json = r.content['application/json'];
      if (!json) continue;
      const isError = !r.status.startsWith('2');
      const schema = isError ? ErrorEnvelope : responseSchemas[`${r.key} ${r.status}`];
      expect(schema, `no zod schema registered for ${r.key} ${r.status}`).toBeDefined();
      for (const ex of examplesOf(json)) {
        const res = (schema as z.ZodType).safeParse(ex);
        expect(res.success, `${r.key} ${r.status}: ${res.success ? '' : res.error.message}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('every registered response schema is documented in the spec', () => {
    const documented = new Set(
      all.filter((r) => r.content['application/json'] && r.status.startsWith('2')).map((r) => `${r.key} ${r.status}`),
    );
    for (const k of Object.keys(responseSchemas)) expect(documented.has(k), k).toBe(true);
  });

  it('NDJSON stream examples are lines that each parse as a ChatStreamEvent', () => {
    const r = all.find((x) => x.key === 'POST /courses/{course}/threads/{threadId}/messages' && x.status === '200');
    const nd = r?.content['application/x-ndjson'];
    expect(nd).toBeDefined();
    for (const ex of examplesOf(nd as Resp['content'][string])) {
      const lines = String(ex).split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) expect(ChatStreamEvent.safeParse(JSON.parse(l)).success, l).toBe(true);
    }
  });
});

describe('zod schemas', () => {
  it('Me requires a 1.x apiVersion', () => {
    const good = { login: 'local', apiVersion: '1.0.0', device: { id: 'd1', name: 'Pixel' } };
    expect(Me.safeParse(good).success).toBe(true);
    expect(Me.safeParse({ ...good, apiVersion: '2.0.0' }).success).toBe(false);
    expect(Me.safeParse({ login: 'local' }).success).toBe(false);
  });

  it('PairRequest rejects malformed codes and empty device names', () => {
    expect(PairRequest.safeParse({ code: 'AbC12345', deviceName: 'Pixel' }).success).toBe(true);
    expect(PairRequest.safeParse({ code: 'short', deviceName: 'Pixel' }).success).toBe(false);
    expect(PairRequest.safeParse({ code: 'AbC12345', deviceName: '' }).success).toBe(false);
  });

  it('ErrorEnvelope rejects unknown codes, extra shape and a bare string error', () => {
    expect(ErrorEnvelope.safeParse({ error: { code: 'unauthorized', message: 'no' } }).success).toBe(true);
    expect(ErrorEnvelope.safeParse({ error: { code: 'teapot', message: 'no' } }).success).toBe(false);
    expect(ErrorEnvelope.safeParse({ error: 'no' }).success).toBe(false);
    expect(ErrorEnvelope.safeParse({ error: { code: 'internal' } }).success).toBe(false);
  });

  it('ChatStreamEvent rejects an unknown event type', () => {
    expect(ChatStreamEvent.safeParse({ type: 'delta', text: 'hi' }).success).toBe(true);
    expect(ChatStreamEvent.safeParse({ type: 'wat' }).success).toBe(false);
  });
});
