// @vitest-environment node
// Course reference on the notes and threads routes: the {course} segment is a slug or a UUID of a COURSE.
// A research project (by slug or by UUID) answers exactly like an unknown reference.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const course = { id: '22222222-2222-4222-8222-222222222222', slug: 'algo', name: 'Algo', kind: 'course' };
const research = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'kairos',
  name: 'KAIROS',
  kind: 'research',
};
const THREAD_ID = '33333333-3333-4333-8333-333333333333';
const NOTE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const thread = {
  id: THREAD_ID,
  projectId: course.id,
  title: 'T',
  documentId: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const note = { id: NOTE_ID, slug: 'n', title: 'N', body: 'b', updatedAt: NOW };

const getProjectBySlug = vi.fn(async (s: string) => [research, course].find((p) => p.slug === s));
const getProjectById = vi.fn(async (id: string) => [research, course].find((p) => p.id === id));
vi.mock('@/lib/projects', () => ({
  getProjectBySlug,
  getProjectById,
  listProjects: vi.fn(async () => []),
  projectMeta: vi.fn(() => ({})),
}));
vi.mock('@/lib/documents', () => ({
  getDocument: vi.fn(),
  getDocumentPages: vi.fn(async () => []),
  listDocuments: vi.fn(async () => []),
  countDocuments: vi.fn(async () => 0),
  listFolders: vi.fn(async () => []),
  listPracticeExams: vi.fn(async () => []),
}));
vi.mock('@/lib/sessions', () => ({ listSessions: vi.fn(async () => []), sessionTitle: vi.fn() }));
vi.mock('@/lib/homework', () => ({ listAssignments: vi.fn(async () => []) }));
vi.mock('@/lib/lemida/files', () => ({ lemidaFilesByProject: vi.fn(async () => []) }));
vi.mock('@/lib/mobile/auth', () => ({
  authenticate: vi.fn(async (r: Request) =>
    r.headers.get('authorization') === 'Bearer dev-token'
      ? { tokenId: 'tok-1', deviceName: 'Test phone' }
      : null,
  ),
}));
const listNotes = vi.fn(async (_projectId: string) => [note]);
const getNote = vi.fn(async (_projectId: string, _id: string) => note);
vi.mock('@/lib/notes', () => ({ listNotes, getNote }));
vi.mock('@/app/api/mobile/v1/courses/[course]/notes/context', () => ({
  noteContexts: vi.fn(async () => new Map()),
}));
const listThreads = vi.fn(async (_projectId: string, _doc: string | null) => [thread]);
const createThread = vi.fn(async (_projectId: string, _input: unknown) => thread);
const getThread = vi.fn(async (_projectId: string, _id: string) => thread);
const deleteThread = vi.fn(async (_projectId: string, _id: string) => undefined);
const listMessages = vi.fn(async (_threadId: string) => []);
vi.mock('@/lib/chat', () => ({ listThreads, createThread, getThread, deleteThread, listMessages }));
vi.mock('@/lib/ai/provider', () => ({ aiConfigured: vi.fn(() => false) }));
vi.mock('@/lib/chat-turn', () => ({ startChatTurn: vi.fn() }));

const notesList = await import('./notes/route');
const notesOne = await import('./notes/[noteId]/route');
const threadsRoute = await import('./threads/route');
const threadOne = await import('./threads/[threadId]/route');
const messages = await import('./threads/[threadId]/messages/route');

const AUTH = { authorization: 'Bearer dev-token' };

interface Case {
  name: string;
  /** Status when the course resolves. */
  okStatus: number;
  /** Message of the not_found body when the course does not resolve. */
  notFound: string;
  run: (ref: string, headers?: Record<string, string>) => Promise<Response>;
  /** The downstream call that must receive the course id. */
  downstream: () => { mock: { calls: unknown[][] } };
}

const params = (ref: string, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ course: ref, ...extra }),
});
const req = (method: string, headers: Record<string, string>, body?: unknown) =>
  new Request('http://localhost/x', {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const cases: Case[] = [
  {
    name: 'notes GET',
    okStatus: 200,
    notFound: 'No such course',
    run: (ref, h = AUTH) => notesList.GET(req('GET', h), params(ref)),
    downstream: () => listNotes,
  },
  {
    name: 'notes/[noteId] GET',
    okStatus: 200,
    notFound: 'No such course',
    run: (ref, h = AUTH) => notesOne.GET(req('GET', h), params(ref, { noteId: NOTE_ID })),
    downstream: () => getNote,
  },
  {
    name: 'threads GET',
    okStatus: 200,
    notFound: 'Course not found',
    run: (ref, h = AUTH) => threadsRoute.GET(req('GET', h), params(ref)),
    downstream: () => listThreads,
  },
  {
    name: 'threads POST',
    okStatus: 201,
    notFound: 'Course not found',
    run: (ref, h = AUTH) => threadsRoute.POST(req('POST', h, {}), params(ref)),
    downstream: () => createThread,
  },
  {
    name: 'threads/[threadId] DELETE',
    okStatus: 204,
    notFound: 'Course not found',
    run: (ref, h = AUTH) => threadOne.DELETE(req('DELETE', h), params(ref, { threadId: THREAD_ID })),
    downstream: () => deleteThread,
  },
  {
    name: 'messages GET',
    okStatus: 200,
    notFound: 'Course not found',
    run: (ref, h = AUTH) => messages.GET(req('GET', h), params(ref, { threadId: THREAD_ID })),
    downstream: () => getThread,
  },
  {
    // aiConfigured is false, so a resolved course stops at ai_unavailable (503) before any stream starts.
    name: 'messages POST',
    okStatus: 503,
    notFound: 'Course not found',
    run: (ref, h = AUTH) =>
      messages.POST(req('POST', h, { question: 'hi' }), params(ref, { threadId: THREAD_ID })),
    downstream: () => getThread,
  },
];

beforeEach(() => vi.clearAllMocks());

describe.each(cases)('$name', (c) => {
  it('course slug resolves and reaches the data layer with the course id', async () => {
    const res = await c.run(course.slug);
    expect(res.status).toBe(c.okStatus);
    expect(c.downstream().mock.calls[0]?.[0]).toBe(course.id);
  });

  it('unknown slug is 404 not_found', async () => {
    const res = await c.run('no-such-course');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe(c.notFound);
  });

  it('research slug answers exactly like an unknown slug', async () => {
    const unknown = await (await c.run('no-such-course')).text();
    const res = await c.run(research.slug);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(unknown);
    expect(c.downstream()).not.toHaveBeenCalled();
  });

  it('research UUID answers exactly like an unknown slug', async () => {
    const unknown = await (await c.run('no-such-course')).text();
    vi.clearAllMocks();
    const res = await c.run(research.id);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(unknown);
    expect(c.downstream()).not.toHaveBeenCalled();
  });

  // flips in the resolver switch
  it('course UUID is not resolved yet', async () => {
    const res = await c.run(course.id);
    expect(res.status).toBe(404);
    expect(c.downstream()).not.toHaveBeenCalled();
  });

  it('without a device token: 401 and no project lookup', async () => {
    const res = await c.run(course.slug, {});
    expect(res.status).toBe(401);
    expect(getProjectBySlug).not.toHaveBeenCalled();
    expect(getProjectById).not.toHaveBeenCalled();
  });
});
