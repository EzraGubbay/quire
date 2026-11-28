import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoStale, expectGolden, goldenResult, MISSING_ID, type NormCtx, normalize } from './mcp-golden';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx: NormCtx = {
  ids: { doc: ID },
  slugs: { 'golden-course-ab12cd34': 'course' },
  run: 'ab12cd34',
  filesDir: '/tmp/files-dir',
  step: 'unit',
};

describe('normalize', () => {
  it('maps seeded ids, the missing id, slugs, run tokens and timestamps', () => {
    expect(
      normalize(
        { s: `${ID} ${MISSING_ID} golden-course-ab12cd34 Golden ab12cd34 2026-01-01T00:00:00.000Z` },
        ctx,
      ),
    ).toEqual({ s: '<id:doc> <id:missing> <slug:course> Golden <run> <ts>' });
  });
  it('replaces the slug before the run token it contains', () => {
    expect(normalize('golden-course-ab12cd34/ab12cd34', ctx)).toBe('<slug:course>/<run>');
  });
  it('throws on a uuid it was not told about', () => {
    expect(() => normalize('x 22222222-2222-4222-8222-222222222222', ctx)).toThrow(/unknown uuid in unit/);
  });
  it('throws when FILES_DIR leaks', () => {
    expect(() => normalize('see /tmp/files-dir/a.pdf', ctx)).toThrow(/FILES_DIR leaked/);
  });
});

describe('goldenResult', () => {
  const g = (content: unknown[], isError?: boolean) => goldenResult({ content, isError }, ctx, 72_000);
  it('classifies pretty JSON, multi-line text and plain text', () => {
    const json = JSON.stringify({ a: ID }, null, 2);
    expect(g([{ type: 'text', text: json }])).toEqual({
      content: [{ type: 'text', json: { a: '<id:doc>' } }],
    });
    expect(g([{ type: 'text', text: 'a\nb' }])).toEqual({ content: [{ type: 'text', lines: ['a', 'b'] }] });
    expect(g([{ type: 'text', text: 'one' }])).toEqual({ content: [{ type: 'text', text: 'one' }] });
  });
  it('keeps non-pretty JSON as text so formatting drift is caught', () => {
    expect(g([{ type: 'text', text: '{"a":1}' }])).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
  });
  it('keeps isError only when true', () => {
    expect(g([], true)).toEqual({ isError: true, content: [] });
    expect(g([], false)).toEqual({ content: [] });
  });
  it('reduces images to shape only', () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64');
    expect(g([{ type: 'image', mimeType: 'image/jpeg', data }])).toEqual({
      content: [{ type: 'image', mimeType: 'image/jpeg', jpeg: true, nonEmpty: true, withinCap: true }],
    });
  });
  it('hashes blobs', () => {
    const blob = Buffer.from('hello').toString('base64');
    const out = goldenResult(
      { contents: [{ uri: 'quire://x', mimeType: 'application/pdf', blob }] },
      ctx,
      1,
    ) as {
      contents: { blob: { bytes: number; sha256: string } }[];
    };
    expect(out.contents[0]?.blob).toEqual({
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
  });
});

describe('expectGolden and assertNoStale', () => {
  let tmp = '';
  let g: { dir: URL; dumpDir: URL };
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-golden-unit-'));
    g = {
      dir: pathToFileURL(`${tmp}/golden/`),
      dumpDir: pathToFileURL(`${tmp}/dump/`),
    };
  });
  afterEach(async () => {
    delete process.env.UPDATE_GOLDENS;
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes under UPDATE_GOLDENS, then compares', async () => {
    process.env.UPDATE_GOLDENS = '1';
    await expectGolden(g, 'a', { x: 1 });
    expect(await readFile(new URL('a.json', g.dir), 'utf8')).toBe('{\n  "x": 1\n}\n');
    delete process.env.UPDATE_GOLDENS;
    await expectGolden(g, 'a', { x: 1 });
  });
  it('dumps the actual output and fails on a mismatch or a missing golden', async () => {
    process.env.UPDATE_GOLDENS = '1';
    await expectGolden(g, 'a', { x: 1 });
    delete process.env.UPDATE_GOLDENS;
    await expect(expectGolden(g, 'a', { x: 2 })).rejects.toThrow();
    expect(await readFile(new URL('a.json', g.dumpDir), 'utf8')).toBe('{\n  "x": 2\n}\n');
    await expect(expectGolden(g, 'nope', {})).rejects.toThrow();
  });
  it('flags stale and missing files, and deletes stale ones when updating', async () => {
    process.env.UPDATE_GOLDENS = '1';
    await expectGolden(g, 'a', 1);
    await expectGolden(g, 'old', 1);
    delete process.env.UPDATE_GOLDENS;
    await expect(assertNoStale(g.dir, ['a'])).rejects.toThrow();
    await expect(assertNoStale(g.dir, ['a', 'old', 'b'])).rejects.toThrow();
    process.env.UPDATE_GOLDENS = '1';
    await assertNoStale(g.dir, ['a']);
    expect(await readdir(new URL('.', g.dir))).toEqual(['a.json']);
    await writeFile(new URL('note.txt', g.dir), 'ignored');
    await assertNoStale(g.dir, ['a']);
  });
});
