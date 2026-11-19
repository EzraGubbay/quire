// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFixtures, FIXTURES_DIR, SPEC_PATH } from './fixtures';
import { ChatStreamEvent, ErrorEnvelope } from './schema';

const specText = readFileSync(SPEC_PATH, 'utf8');
const built = buildFixtures(specText);
const dir = fileURLToPath(new URL(`../../../../../${FIXTURES_DIR}/`, import.meta.url));

describe('mobile contract fixtures', () => {
  it('generates fixtures for every endpoint, the error envelope and both chat streams', () => {
    const names = [...built.keys()];
    expect(names).toContain('getMe.200.json');
    expect(names).toContain('pairDevice.request.json');
    expect(names).toContain('error.unauthorized.json');
    expect(names).toContain('postMessage.200.normal.ndjson');
    expect(names).toContain('postMessage.200.error-mid-stream.ndjson');
  });

  it('committed fixtures are up to date (run `pnpm --filter web mobile:fixtures`)', () => {
    for (const [name, content] of built) {
      expect(existsSync(`${dir}${name}`), `${name} is missing`).toBe(true);
      expect(readFileSync(`${dir}${name}`, 'utf8'), `${name} is stale`).toBe(content);
    }
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.ndjson'));
    expect(onDisk.sort()).toEqual([...built.keys()].sort());
  });

  it('error fixtures parse as the error envelope', () => {
    const errs = [...built].filter(([n]) => n.startsWith('error.'));
    expect(errs.length).toBe(6);
    for (const [, c] of errs) expect(ErrorEnvelope.safeParse(JSON.parse(c)).success).toBe(true);
  });

  it('chat fixtures are NDJSON of ChatStreamEvents; normal ends in done, the failure in error', () => {
    const parse = (n: string) =>
      (built.get(n) as string)
        .split('\n')
        .filter(Boolean)
        .map((l) => ChatStreamEvent.parse(JSON.parse(l)));
    const normal = parse('postMessage.200.normal.ndjson');
    expect(normal[0]?.type).toBe('user');
    expect(normal.at(-1)?.type).toBe('done');
    const failed = parse('postMessage.200.error-mid-stream.ndjson');
    expect(failed.some((e) => e.type === 'delta')).toBe(true);
    expect(failed.at(-1)?.type).toBe('error');
  });
});
