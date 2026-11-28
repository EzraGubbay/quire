import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changedFiles,
  decide,
  main,
  parseNameOnlyZ,
  RENDER_PATHS,
} from '../../../scripts/render-smoke/gate.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const pr = (changed: string[], over: Record<string, unknown> = {}) =>
  decide({ event: 'pull_request', base: A, head: B, changed, ...over });

describe('render smoke gate: decide', () => {
  it('runs when the event is not a pull_request', () => {
    expect(decide({ event: 'workflow_dispatch', base: A, head: B, changed: ['docs/x.md'] }).run).toBe(true);
    expect(decide({ event: undefined, base: A, head: B, changed: ['docs/x.md'] }).run).toBe(true);
  });

  it.each([
    ['missing base', { base: undefined }],
    ['missing head', { head: undefined }],
    ['short base', { base: 'abc123' }],
    ['non-hex head', { head: 'z'.repeat(40) }],
    ['all-zero base', { base: '0'.repeat(40) }],
    ['all-zero head', { head: '0'.repeat(40) }],
  ])('runs on %s', (_n, over) => {
    expect(pr(['docs/x.md'], over).run).toBe(true);
  });

  it('runs when git failed, and says why', () => {
    const v = pr([], { error: 'fatal: no merge base\nmore' });
    expect(v.run).toBe(true);
    expect(v.reason).toContain('fatal: no merge base');
    expect(v.reason).not.toContain('\n');
  });

  it('runs on an empty diff', () => {
    expect(pr([]).run).toBe(true);
    expect(pr([], { changed: undefined }).run).toBe(true);
  });

  it.each(['docs/a b.md', 'docs/a\tb.md', 'docs/a\nb.md', 'docs/a\u0001b.md'])('runs on odd path %j', (p) => {
    expect(pr([p]).run).toBe(true);
  });

  it.each(RENDER_PATHS)('runs when %s changes', (entry) => {
    const file = entry.endsWith('/') ? `${entry}child.mjs` : entry;
    const v = pr(['docs/x.md', file]);
    expect(v.run).toBe(true);
    expect(v.reason).toContain(file);
  });

  it.each([
    'apps/web/src/lib/slides.test.ts',
    'apps/web/src/lib/pdf-layout.ts',
    'infra/Dockerfile.dev',
    'apps/web/scripts/render-smoke-notes.md',
    'apps/web/src/core/pdfx/open.ts',
    'docs/x.md',
  ])('skips a near-miss: %s', (p) => {
    const v = pr([p, 'README.md']);
    expect(v.run).toBe(false);
    expect(v.reason).toContain('2 files');
  });

  it('runs when a render file was deleted, or only the old name of a rename is relevant', () => {
    expect(pr(['apps/web/src/lib/slides.ts']).run).toBe(true);
    expect(pr(['apps/web/src/lib/pdf.ts', 'apps/web/src/lib/pdf-old-name.ts']).run).toBe(true);
  });
});

describe('render smoke gate: git plumbing', () => {
  it('parseNameOnlyZ drops empty entries and the trailing NUL', () => {
    expect(parseNameOnlyZ('a.ts\0b/c.ts\0')).toEqual(['a.ts', 'b/c.ts']);
    expect(parseNameOnlyZ('a.ts\0\0b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(parseNameOnlyZ('')).toEqual([]);
  });

  it('changedFiles asks git for a rename-free NUL-separated three-dot diff', () => {
    const calls: unknown[][] = [];
    const exec = (...a: unknown[]) => {
      calls.push(a);
      return 'x.ts\0y.ts\0';
    };
    expect(changedFiles(A, B, exec as never)).toEqual(['x.ts', 'y.ts']);
    expect(calls[0]?.[0]).toBe('git');
    expect(calls[0]?.[1]).toEqual(['diff', '--no-renames', '--name-only', '-z', `${A}...${B}`]);
  });
});

describe('render smoke gate: main', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const outFile = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'gate-'));
    dirs.push(d);
    const f = path.join(d, 'output');
    writeFileSync(f, '');
    return f;
  };

  it('writes run= and a one-line reason to GITHUB_OUTPUT', () => {
    const f = outFile();
    main(
      ['--event', 'pull_request', '--base', A, '--head', B],
      { GITHUB_OUTPUT: f },
      (() => 'docs/x.md\0README.md\0') as never,
    );
    const lines = readFileSync(f, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('run=false');
    expect(lines[1]).toMatch(/^reason=no render-relevant path changed \(2 files\)$/);
  });

  it('still writes run=true when the diff throws', () => {
    const f = outFile();
    main(['--event', 'pull_request', '--base', A, '--head', B], { GITHUB_OUTPUT: f }, (() => {
      throw new Error('fatal: bad object\nsecond line');
    }) as never);
    const text = readFileSync(f, 'utf8');
    expect(text).toContain('run=true\n');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(text).toContain('fatal: bad object');
  });
});
