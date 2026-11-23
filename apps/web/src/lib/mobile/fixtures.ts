// Builds the offline contract fixtures for the mobile apps from the examples in the OpenAPI document, plus one
// fixture per push payload from the pure push event builders. Pure (string in, map out) so the staleness test and
// scripts/mobile-fixtures.mts share one implementation.
import { parse } from 'yaml';
import { pushFixtures } from './push/events';

/** Repo-relative output directory of the committed fixtures. */
export const FIXTURES_DIR = 'docs/api/fixtures/mobile-v1';
export const SPEC_PATH = new URL('../../../../../docs/api/mobile-v1.openapi.yaml', import.meta.url);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Media {
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}
interface Node {
  [k: string]: unknown;
}

/** Examples of a media type as [name | null, value]; a lone `example` is unnamed. */
function examplesOf(media: Media): Array<[string | null, unknown]> {
  if (media.example !== undefined) return [[null, media.example]];
  return Object.entries(media.examples ?? {}).map(([k, v]) => [k, v.value]);
}

/** @returns file name to exact file content. */
export function buildFixtures(specText: string): Map<string, string> {
  const spec = parse(specText) as Node & { paths: Record<string, Node>; components: Node };
  const out = new Map<string, string>();
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const ndjson = (v: unknown) => `${String(v).trim()}\n`;
  const emit = (stem: string, name: string | null, mediaType: string, value: unknown) => {
    const suffix = name ? `.${name}` : '';
    if (mediaType === 'application/json') out.set(`${stem}${suffix}.json`, json(value));
    else if (mediaType === 'application/x-ndjson') out.set(`${stem}${suffix}.ndjson`, ndjson(value));
  };

  for (const item of Object.values(spec.paths)) {
    for (const m of METHODS) {
      const op = item[m] as Node | undefined;
      if (!op) continue;
      const id = op.operationId as string;
      const body = (op.requestBody as { content?: Record<string, Media> } | undefined)?.content;
      for (const [type, media] of Object.entries(body ?? {}))
        for (const [name, v] of examplesOf(media)) emit(`${id}.request`, name, type, v);
      for (const [status, r] of Object.entries(op.responses as Record<string, Node>)) {
        if (r.$ref) continue; // shared error responses are emitted once, below
        const content = (r.content ?? {}) as Record<string, Media>;
        for (const [type, media] of Object.entries(content))
          for (const [name, v] of examplesOf(media)) emit(`${id}.${status}`, name, type, v);
      }
    }
  }

  // One fixture per error code, from the shared response components.
  const responses = (spec.components.responses ?? {}) as Record<string, { content?: Record<string, Media> }>;
  for (const r of Object.values(responses)) {
    for (const [, v] of examplesOf(r.content?.['application/json'] ?? {})) {
      const code = (v as { error: { code: string } }).error.code;
      out.set(`error.${code}.json`, json(v));
    }
  }

  // One `push.<type>.json` per push payload: the FCM data map exactly as sent, from the events.ts builders.
  for (const [name, data] of pushFixtures()) out.set(name, json(data));
  return out;
}
