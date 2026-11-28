// @vitest-environment node
// Golden transcripts of both MCP servers against a seeded, synthetic course and research project, through the
// real SDK over an in-memory transport. Opt-in, like the other db.integration tests, and ONLY against a
// throwaway database (the seed deletes its own rows, but a dev database holding real data must never be used):
//   QUIRE_DB_TESTS=1 DATABASE_URL=postgres://… pnpm --filter web exec vitest run golden
// Regenerate the goldens with UPDATE_GOLDENS=1 and review the diff: it is the intended behaviour change.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNoStale,
  connectMcp,
  expectGolden,
  type GoldenDir,
  goldenResult,
  type NormCtx,
  normalize,
  pinEnv,
} from '@/lib/testing/mcp-golden';

const run = process.env.QUIRE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MISSING = '00000000-0000-4000-8000-000000000000';
const tmp = run ? await mkdtemp(path.join(os.tmpdir(), 'quire-mcp-golden-')) : '';
if (run) {
  process.env.FILES_DIR = tmp;
  pinEnv();
  // pdf.js draws the Type 3 glyphs of the synthetic PDFs with Path2D, and outside Next it cannot polyfill it
  // from @napi-rs/canvas itself ("Value is none of these types String, Path"). Pages that embed a raster image
  // (sample pages 2 and 4) abort the native canvas under Node, so the image steps only render pages 1 and 3.
  const canvas = await import('@napi-rs/canvas');
  Object.assign(globalThis, { Path2D: canvas.Path2D });
}

const golden = (server: 'course' | 'research'): GoldenDir => ({
  dir: new URL(`./__golden__/${server}/`, import.meta.url),
  dumpDir: new URL(`../../../test-results/mcp-golden/${server}/`, import.meta.url),
});

type Seed = Awaited<ReturnType<typeof import('@/lib/testing/seed-course')['seedGolden']>>;
let seed: Seed;

describe.skipIf(!run)('MCP golden transcripts (integration)', () => {
  beforeAll(async () => {
    const { seedGolden } = await import('@/lib/testing/seed-course');
    seed = await seedGolden(RUN);
  });
  afterAll(async () => {
    await seed?.cleanup();
    await rm(tmp, { recursive: true, force: true });
    const { getSql } = await import('@/db/client');
    await getSql().end();
  });

  it('seed builds the fixture', async () => {
    const { listCourseFiles } = await import('./courses');
    const { listDocuments } = await import('@/lib/documents');
    const { listNotes } = await import('@/lib/notes');
    const { listSources } = await import('@/lib/sources');
    const { files } = await listCourseFiles(seed.course.id);
    expect(files).toHaveLength(8);
    expect(new Set(files.map((f) => f.type))).toEqual(
      new Set(['lecture', 'recitation', 'exam', 'homework', 'book', 'paper', 'other']),
    );
    expect(await listDocuments(seed.research.id)).toHaveLength(3);
    expect(await listNotes(seed.research.id)).toHaveLength(1);
    expect(await listSources(seed.research.id)).toHaveLength(1);
  });

  const ctxFor = (step: string): NormCtx => ({
    ids: seed.ids,
    slugs: { [seed.course.slug]: 'course', [seed.research.slug]: 'research' },
    run: RUN,
    filesDir: tmp,
    step,
  });
  const imageMax = async () => (await import('./content')).IMAGE_MAX_BYTES;

  type ToolRes = { content?: unknown[]; isError?: boolean };
  const textOf = (r: ToolRes): string =>
    String((r.content?.[0] as { text?: string } | undefined)?.text ?? '');
  const jsonOf = (r: ToolRes): Record<string, unknown> => JSON.parse(textOf(r));

  /** Calls a tool, writes/compares its golden, and returns the raw result for follow-up assertions. */
  async function tool(
    client: Client,
    server: 'course' | 'research',
    name: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolRes> {
    const res = (await client.callTool({ name: toolName, arguments: args })) as ToolRes;
    const ctx = ctxFor(name);
    await expectGolden(golden(server), name, {
      request: { method: 'tools/call', name: toolName, arguments: normalize(args, ctx) },
      response: goldenResult(res, ctx, await imageMax()),
    });
    return res;
  }

  /** Same, for a golden whose response was filtered to the seeded entities first. */
  async function filtered(
    server: 'course' | 'research',
    name: string,
    request: Record<string, unknown>,
    response: unknown,
  ): Promise<void> {
    const ctx = ctxFor(name);
    await expectGolden(golden(server), name, {
      request: normalize(request, ctx),
      response: normalize(response, ctx),
    });
  }

  async function resourceRead(client: Client, server: 'course' | 'research', name: string, uri: string) {
    const res = await client.readResource({ uri });
    const ctx = ctxFor(name);
    await expectGolden(golden(server), name, {
      request: { method: 'resources/read', uri: normalize(uri, ctx) },
      response: goldenResult(res as { contents: unknown[] }, ctx, 0),
    });
    return res;
  }

  /** Concurrent db tests can delete their project between listProjects and listCourseFiles: retry. */
  async function seededResources(client: Client, slug: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        const { resources } = await client.listResources();
        return resources.filter((r) => r.uri.includes(`/${slug}/`));
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
  }

  async function writeCounts() {
    const { listDocuments } = await import('@/lib/documents');
    const { listNotes } = await import('@/lib/notes');
    const out: number[] = [];
    for (const id of [seed.course.id, seed.research.id]) {
      out.push((await listDocuments(id)).length, (await listNotes(id)).length);
    }
    return out;
  }

  const COURSE_STEPS = [
    'tools-list',
    'resource-templates',
    'list_courses',
    'list_course_files',
    'list_course_files.research-slug',
    'get_file.lecture.text',
    'get_file.lecture.pages-2_4',
    'get_file.book.text',
    'get_file.book.continue',
    'get_file.cheatsheet.text',
    'get_file.cheatsheet.markdown',
    'get_file.lecture.pdf',
    'get_file.pptx-deck.text',
    'get_file.pptx-deck.original',
    'get_file.course-paper.text',
    'get_file.lecture.bad-pages',
    'get_file.lecture.past-end',
    'get_file.missing-file',
    'get_file.lecture.markdown-on-pdf',
    'get_page_images.lecture.p1',
    'get_page_images.lecture.p3',
    'get_page_images.course-paper',
    'get_page_images.bad-pages',
    'resources.list',
    'resources.read.lecture',
    'resources.read.cheatsheet',
    'upload_markdown.missing-course',
    'upload_markdown.invalid-args',
    'upload_pdf.missing-course',
    'create_upload_link.missing-course',
    'create_upload_link.pdf-into-notes',
    'get_upload_status.unknown',
  ];

  it('course server transcript', async () => {
    const { registerQuireMcp } = await import('./server');
    const client = await connectMcp(registerQuireMcp);
    const S = 'course' as const;
    const id = seed.ids;
    const slug = seed.course.slug;
    const f = (name: string, extra: Record<string, unknown> = {}) => ({
      course: slug,
      fileId: id[name],
      ...extra,
    });
    const before = await writeCounts();

    const courses = jsonOf((await client.callTool({ name: 'list_courses', arguments: {} })) as ToolRes);
    const mine = (courses.courses as { slug: string }[]).filter((c) => c.slug === slug);
    expect(mine).toHaveLength(1);
    expect((courses.courses as { slug: string }[]).some((c) => c.slug === seed.research.slug)).toBe(false);
    await filtered(S, 'list_courses', { method: 'tools/call', name: 'list_courses' }, { courses: mine });

    await tool(client, S, 'list_course_files', 'list_course_files', { course: slug });
    const byId = await client.callTool({ name: 'list_course_files', arguments: { course: seed.course.id } });
    const bySlug = await client.callTool({ name: 'list_course_files', arguments: { course: slug } });
    expect(textOf(byId as ToolRes)).toBe(textOf(bySlug as ToolRes));
    expect(
      (
        await tool(client, S, 'list_course_files.research-slug', 'list_course_files', {
          course: seed.research.slug,
        })
      ).isError,
    ).toBe(true);

    const lecture = await tool(client, S, 'get_file.lecture.text', 'get_file', f('lecture-deck'));
    await tool(client, S, 'get_file.lecture.pages-2_4', 'get_file', f('lecture-deck', { pages: '2,4' }));
    const again = (await client.callTool({ name: 'get_file', arguments: f('lecture-deck') })) as ToolRes;
    expect(textOf(again), 'second read (text cache) equals the first').toBe(textOf(lecture));

    const book = await tool(client, S, 'get_file.book.text', 'get_file', f('book'));
    const more = /\[More pages: call get_file again with pages="([^"]+)"/.exec(textOf(book));
    expect(more, 'the book exceeds the text budget').not.toBeNull();
    await tool(client, S, 'get_file.book.continue', 'get_file', f('book', { pages: more?.[1] }));

    await tool(client, S, 'get_file.cheatsheet.text', 'get_file', f('cheatsheet'));
    await tool(
      client,
      S,
      'get_file.cheatsheet.markdown',
      'get_file',
      f('cheatsheet', { format: 'markdown' }),
    );
    await tool(client, S, 'get_file.lecture.pdf', 'get_file', f('lecture-deck', { format: 'pdf' }));
    await tool(client, S, 'get_file.pptx-deck.text', 'get_file', f('pptx-deck'));
    await tool(client, S, 'get_file.pptx-deck.original', 'get_file', f('pptx-deck', { format: 'original' }));
    await tool(client, S, 'get_file.course-paper.text', 'get_file', f('course-paper'));
    await tool(client, S, 'get_file.lecture.bad-pages', 'get_file', f('lecture-deck', { pages: 'x' }));
    await tool(client, S, 'get_file.lecture.past-end', 'get_file', f('lecture-deck', { pages: '9' }));
    await tool(client, S, 'get_file.missing-file', 'get_file', { course: slug, fileId: MISSING });
    await tool(
      client,
      S,
      'get_file.lecture.markdown-on-pdf',
      'get_file',
      f('lecture-deck', { format: 'markdown' }),
    );

    await tool(client, S, 'get_page_images.lecture.p1', 'get_page_images', f('lecture-deck', { pages: '1' }));
    await tool(client, S, 'get_page_images.lecture.p3', 'get_page_images', f('lecture-deck', { pages: '3' }));
    // Not a golden: the cut-off after the base64 budget depends on JPEG size, which depends on the platform.
    const many = (await client.callTool({
      name: 'get_page_images',
      arguments: f('lecture-deck', { pages: '1,3' }),
    })) as ToolRes;
    const images = (many.content ?? []).filter((c) => (c as { type: string }).type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images.length).toBeLessThanOrEqual(2);
    await tool(
      client,
      S,
      'get_page_images.course-paper',
      'get_page_images',
      f('course-paper', { pages: '1' }),
    );
    await tool(client, S, 'get_page_images.bad-pages', 'get_page_images', f('lecture-deck', { pages: 'x' }));

    const listed = await seededResources(client, slug);
    expect(listed).toHaveLength(8);
    await filtered(S, 'resources.list', { method: 'resources/list' }, { resources: listed });
    await resourceRead(
      client,
      S,
      'resources.read.lecture',
      `quire://course/${slug}/file/${id['lecture-deck']}`,
    );
    await resourceRead(
      client,
      S,
      'resources.read.cheatsheet',
      `quire://course/${slug}/file/${id.cheatsheet}`,
    );

    const missing = `golden-missing-${RUN}`;
    await tool(client, S, 'upload_markdown.missing-course', 'upload_markdown', {
      course: missing,
      markdown: '# T\nbody',
    });
    await tool(client, S, 'upload_markdown.invalid-args', 'upload_markdown', { course: slug });
    await tool(client, S, 'upload_pdf.missing-course', 'upload_pdf', {
      course: missing,
      url: 'https://example.org/x.pdf',
    });
    await tool(client, S, 'create_upload_link.missing-course', 'create_upload_link', {
      course: missing,
      section: 'documents',
      filename: 'x.pdf',
    });
    await tool(client, S, 'create_upload_link.pdf-into-notes', 'create_upload_link', {
      course: slug,
      section: 'notes',
      filename: 'x.pdf',
    });
    await tool(client, S, 'get_upload_status.unknown', 'get_upload_status', { uploadId: 'nope' });

    expect(await writeCounts(), 'write-tool error paths must not write').toEqual(before);
    await assertNoStale(golden(S).dir, COURSE_STEPS);
  });
});
