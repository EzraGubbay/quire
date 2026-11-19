// Regenerates docs/api/fixtures/mobile-v1/ from the examples in docs/api/mobile-v1.openapi.yaml.
// Run: pnpm --filter web mobile:fixtures. A vitest test fails when the committed output is stale.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFixtures, FIXTURES_DIR, SPEC_PATH } from '../src/lib/mobile/fixtures.ts';

const outDir = fileURLToPath(new URL(`../../../${FIXTURES_DIR}/`, import.meta.url));
const fixtures = buildFixtures(readFileSync(SPEC_PATH, 'utf8'));

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (/\.(nd)?json$/.test(f)) rmSync(`${outDir}${f}`);
for (const [name, content] of fixtures) writeFileSync(`${outDir}${name}`, content);
console.log(`wrote ${fixtures.size} fixtures to ${FIXTURES_DIR}`);
