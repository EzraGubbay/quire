// Path gate for the render smoke workflow. Decides whether a pull request touches anything that can change what
// ships in the runtime image or how pages render. Fail-safe: any doubt (not a PR, bad SHAs, git failure, empty
// or odd-looking diff) means run. The CLI always exits 0 and writes `run=true|false` and `reason=...`.
// Usage: node gate.mjs --event <name> --base <sha> --head <sha>
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Exact paths, plus prefixes (entries ending in `/`). */
export const RENDER_PATHS = [
  'apps/web/src/lib/slides.ts',
  'apps/web/src/lib/pdf.ts',
  'apps/web/src/lib/mcp/content.ts',
  'infra/Dockerfile',
  'apps/web/package.json',
  'pnpm-lock.yaml',
  'apps/web/scripts/copy-pdf-worker.mjs',
  '.github/workflows/render-smoke.yml',
  'apps/web/scripts/render-smoke/',
  'apps/web/src/lib/testing/smoke-pdfs.test.ts',
  'apps/web/src/lib/testing/render-smoke-gate.test.ts',
  'apps/web/src/lib/testing/render-smoke-mirror.test.ts',
  // serverExternalPackages and file tracing decide which pdf.js and canvas files are in the image.
  'apps/web/next.config.ts',
  'apps/web/src/lib/pdf-polyfill.ts',
  'apps/web/src/core/pdf/',
  'pnpm-workspace.yaml',
  'package.json',
  // Absent today; creating one changes the docker build context.
  '.dockerignore',
];

const SHA = /^[0-9a-f]{40}$/;
const oddPath = (p) => Array.from(p).some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f);

export function decide({ event, base, head, changed, error }) {
  if (event !== 'pull_request') return { run: true, reason: 'not a pull_request event' };
  for (const sha of [base, head]) {
    if (typeof sha !== 'string' || !SHA.test(sha) || /^0+$/.test(sha)) {
      return { run: true, reason: 'base or head SHA missing or invalid' };
    }
  }
  if (error) return { run: true, reason: `could not diff (${String(error).split('\n')[0]})` };
  if (!Array.isArray(changed) || changed.length === 0) return { run: true, reason: 'empty diff' };
  if (changed.some(oddPath))
    return { run: true, reason: 'a changed path has whitespace or control characters' };
  const hits = changed.filter((p) => RENDER_PATHS.some((r) => (r.endsWith('/') ? p.startsWith(r) : p === r)));
  if (hits.length)
    return { run: true, reason: `render-relevant paths changed: ${hits.slice(0, 5).join(', ')}` };
  return { run: false, reason: `no render-relevant path changed (${changed.length} files)` };
}

export const parseNameOnlyZ = (stdout) =>
  String(stdout)
    .split('\0')
    .filter((s) => s.length > 0);

/** Old and new names both appear (`--no-renames`), so a file moved out of a relevant path still counts. */
export function changedFiles(base, head, exec = execFileSync) {
  const out = exec('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseNameOnlyZ(out);
}

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function main(argv, env = process.env, exec = execFileSync) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = { event: arg('event'), base: arg('base'), head: arg('head') };
  let verdict;
  try {
    let changed;
    let error;
    try {
      changed = changedFiles(input.base, input.head, exec);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    verdict = decide({ ...input, changed, error });
  } catch (err) {
    verdict = { run: true, reason: `gate failed (${err instanceof Error ? err.message : String(err)})` };
  }
  const reason = verdict.reason.replace(/[\r\n]+/g, ' ');
  const lines = `run=${verdict.run}\nreason=${reason}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  return verdict;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, 'run=true\nreason=gate crashed\n');
    else process.stdout.write('run=true\nreason=gate crashed\n');
  }
  process.exit(0);
}
