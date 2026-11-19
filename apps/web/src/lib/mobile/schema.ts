// Single source of truth for the mobile API (`/api/mobile/v1`) wire types. The OpenAPI document at
// docs/api/mobile-v1.openapi.yaml is the written contract; schema.test.ts parses every example in it with
// these schemas so spec and code cannot drift. Pure zod — safe to import from anywhere (no server/db).
import { z } from 'zod';

/** Semver of the v1 contract. Additive-only within v1; breaking changes ship as /v2. */
export const API_VERSION = '1.0.0';

// ── Error envelope ──────────────────────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'unauthorized',
  'not_found',
  'invalid_request',
  'rate_limited',
  'ai_unavailable',
  'internal',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Default HTTP status for each error code (handlers may override). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  ai_unavailable: 503,
  internal: 500,
};

// ── Shared primitives ───────────────────────────────────────────────────────────────────────────────

const Iso = z.iso.datetime();
const Id = z.string().min(1);

export const FileType = z.enum(['lecture', 'recitation', 'homework', 'exam', 'book', 'paper', 'other']);
export type FileType = z.infer<typeof FileType>;
export const FileFormat = z.enum(['pdf', 'original', 'markdown']);
export type FileFormat = z.infer<typeof FileFormat>;
export const SessionKind = z.enum(['lecture', 'recitation']);

// ── Auth ────────────────────────────────────────────────────────────────────────────────────────────

export const PairRequest = z.object({
  /** Short-lived single-use code minted by the web app. */
  code: z.string().regex(/^[0-9A-Za-z]{8}$/),
  deviceName: z.string().min(1).max(100),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const Device = z.object({ id: Id, name: z.string(), createdAt: Iso.optional() });

export const PairResponse = z.object({
  /** Raw per-device bearer token; returned exactly once. */
  token: z.string().min(1),
  device: Device,
});
export type PairResponse = z.infer<typeof PairResponse>;

export const Me = z.object({
  login: z.string().min(1),
  apiVersion: z.string().regex(/^1\.\d+\.\d+$/),
  device: Device,
});
export type Me = z.infer<typeof Me>;

// ── Courses, sessions, files ────────────────────────────────────────────────────────────────────────

export const CourseSummary = z.object({
  slug: z.string(),
  id: Id,
  name: z.string(),
  code: z.string(),
  semester: z.string(),
  type: z.string(),
  fileCount: z.number().int().nonnegative(),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

export const CourseDetail = CourseSummary.extend({
  counts: z.object({
    sessions: z.record(z.string(), z.number().int().nonnegative()),
    files: z.record(z.string(), z.number().int().nonnegative()),
    notes: z.number().int().nonnegative(),
  }),
});
export type CourseDetail = z.infer<typeof CourseDetail>;

export const CourseSession = z.object({
  kind: SessionKind,
  number: z.number().int(),
  title: z.string(),
  date: z.string().nullable(),
  fileIds: z.array(Id),
  noteId: Id.nullable(),
});
export type CourseSession = z.infer<typeof CourseSession>;

export const CourseFile = z.object({
  fileId: Id,
  title: z.string(),
  type: FileType,
  session: z.object({ number: z.number().int(), title: z.string() }).optional(),
  folder: z.string().optional(),
  pageCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  hasPdf: z.boolean(),
  hasOriginal: z.boolean(),
  hasMarkdown: z.boolean(),
  updatedAt: Iso,
});
export type CourseFile = z.infer<typeof CourseFile>;

// ── Notes (read-only) ───────────────────────────────────────────────────────────────────────────────

export const NoteSummary = z.object({
  id: Id,
  slug: z.string(),
  title: z.string(),
  folder: z.string().optional(),
  session: z.object({ kind: SessionKind, number: z.number().int() }).optional(),
  updatedAt: Iso,
});
export type NoteSummary = z.infer<typeof NoteSummary>;

export const Note = NoteSummary.extend({ markdown: z.string() });
export type Note = z.infer<typeof Note>;

// ── Chat ────────────────────────────────────────────────────────────────────────────────────────────

export const Thread = z.object({
  id: Id,
  courseSlug: z.string(),
  title: z.string(),
  documentId: Id.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Thread = z.infer<typeof Thread>;

export const CreateThreadRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  documentId: Id.optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

/** A citation for an `[n]` marker. Strict: the web-only `href` must never leak into the mobile contract. */
export const Citation = z.strictObject({
  n: z.number().int().positive(),
  kind: z.string(),
  id: Id,
  title: z.string(),
  pageNo: z.number().int().optional(),
});
export type Citation = z.infer<typeof Citation>;

export const ChatMessage = z.object({
  id: Id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(Citation),
  error: z.string().nullable(),
  createdAt: Iso,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const PostMessageRequest = z.object({ question: z.string().min(1).max(8000) });
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

/** One NDJSON line of the streamed answer. Identical event vocabulary to the web chat route. */
export const ChatStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), message: ChatMessage }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done'), message: ChatMessage, fallback: z.boolean().optional() }),
  z.object({ type: z.literal('error'), code: ErrorCode, message: z.string(), kind: z.string().optional() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

// ── Uploads (QMOB-E1-S8) ────────────────────────────────────────────────────

export const UploadStatus = z.enum(['queued', 'processing', 'done', 'failed']);
export const UploadJob = z.object({
  uploadId: Id,
  status: UploadStatus,
  fileId: Id.optional(),
  error: z.string().optional(),
});
export type UploadJob = z.infer<typeof UploadJob>;

// ── Registry: success response schema per operation (drift test + handlers) ─────────────────────────

/** Keyed `"METHOD /path status"` exactly as in the OpenAPI document (path relative to /api/mobile/v1). */
export const responseSchemas = {
  'POST /auth/pair 200': PairResponse,
  'GET /me 200': Me,
  'GET /courses 200': z.array(CourseSummary),
  'GET /courses/{course} 200': CourseDetail,
  'GET /courses/{course}/sessions 200': z.array(CourseSession),
  'GET /courses/{course}/files 200': z.array(CourseFile),
  'GET /courses/{course}/files/{fileId} 200': CourseFile,
  'GET /courses/{course}/notes 200': z.array(NoteSummary),
  'GET /courses/{course}/notes/{noteId} 200': Note,
  'GET /threads 200': z.array(Thread),
  'GET /courses/{course}/threads 200': z.array(Thread),
  'POST /courses/{course}/threads 201': Thread,
  'GET /courses/{course}/threads/{threadId}/messages 200': z.array(ChatMessage),
  'POST /courses/{course}/uploads 202': UploadJob,
  'GET /uploads/{uploadId} 200': UploadJob,
} as const satisfies Record<string, z.ZodType>;
