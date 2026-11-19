import type { Document, Session } from '@/db/schema';
import type { CourseSummary, CourseFile as McpCourseFile } from '@/lib/mcp/courses';
import { toCourseDetail, toCourseFile, toCourseSession } from './courses';
import { CourseDetail, CourseFile, CourseSession } from './schema';

const now = new Date('2026-11-01T08:00:00Z');

const mcpFile = (over: Partial<McpCourseFile> = {}): McpCourseFile => ({
  fileId: '6f1c2a52-8b0e-4c6a-9d63-2a3a7c1d9e10',
  title: 'Slides',
  type: 'lecture',
  session: { number: 2, title: 'Lecture 2 — SIMD' },
  folder: undefined,
  pageCount: 10,
  sizeBytes: 1234,
  kind: 'pdf',
  hasPdf: true,
  hasOriginal: false,
  hasMarkdown: false,
  resourceUri: 'quire://course/c/file/x',
  ...over,
});

const session = (over: Partial<Session> = {}): Session => ({
  id: '0d6f6c3e-4f5a-4b0b-8f0e-9a6b1d2c3e4f',
  projectId: 'p1',
  kind: 'lecture',
  number: 2,
  title: 'SIMD',
  date: '2026-10-19',
  createdAt: now,
  updatedAt: now,
  ...over,
});

const summary: CourseSummary = {
  slug: 'hpc',
  id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  name: 'HPC',
  code: '044130',
  semester: 'Winter 2026',
  type: 'lecture',
  fileCount: 3,
};

describe('toCourseFile', () => {
  it('drops MCP-only kind/resourceUri and adds ISO updatedAt', () => {
    const out = toCourseFile(mcpFile(), now);
    expect(out).not.toHaveProperty('kind');
    expect(out).not.toHaveProperty('resourceUri');
    expect(out.updatedAt).toBe('2026-11-01T08:00:00.000Z');
    expect(CourseFile.parse(out)).toBeTruthy();
  });

  it('omits undefined session/folder so the JSON stays clean', () => {
    const out = toCourseFile(mcpFile({ session: undefined, folder: 'Homework', type: 'homework' }), now);
    expect(out).not.toHaveProperty('session');
    expect(out.folder).toBe('Homework');
  });
});

describe('toCourseSession', () => {
  it('maps kind, number, titled label, date, deck ids and note id', () => {
    const out = toCourseSession(
      { ...session(), documents: [{ id: 'd1' }, { id: 'd2' }] as Document[] },
      'n1',
    );
    expect(out).toEqual({
      kind: 'lecture',
      number: 2,
      title: 'Lecture 2 — SIMD',
      date: '2026-10-19',
      fileIds: ['d1', 'd2'],
      noteId: 'n1',
    });
  });

  it('uses null date and note when absent', () => {
    const out = toCourseSession({ ...session({ date: null }), documents: [] }, undefined);
    expect(out.date).toBeNull();
    expect(out.noteId).toBeNull();
    expect(out.fileIds).toEqual([]);
    // Ids here are not UUIDs-shaped only in the first test; schema check uses a valid one.
    expect(CourseSession.safeParse(out).success).toBe(true);
  });
});

describe('toCourseDetail', () => {
  it('counts sessions by kind, files by type, and notes', () => {
    const out = toCourseDetail(
      summary,
      [session(), session({ id: 's2', number: 3 }), session({ id: 's3', kind: 'recitation' })],
      [mcpFile(), mcpFile({ type: 'homework' }), mcpFile({ type: 'lecture' })],
      4,
    );
    expect(out.counts).toEqual({
      sessions: { lecture: 2, recitation: 1 },
      files: { lecture: 2, homework: 1 },
      notes: 4,
    });
    expect(out.slug).toBe('hpc');
    expect(CourseDetail.safeParse(out).success).toBe(true);
  });
});
